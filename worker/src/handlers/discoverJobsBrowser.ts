import { z } from "zod";
import { getConfig, sleep } from "../config";
import { addCommandEvent, getCommandStatus, getExistingUrls, upsertJobs } from "../db";
import {
  buildBrowserSearchUrl,
  extractJobUrlsFromHtml,
  humanDelayMs,
  type BrowserDiscoverySource,
} from "../search/browserDiscovery";
import { extractJobDetail } from "../search/jobDetailExtraction";
import type { HandlerContext, HandlerResult } from "../types";

const sourceLimitsSchema = z
  .object({
    indeed: z.number().int().min(0).max(100).optional(),
    dice: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const payloadSchema = z.object({
  sources: z.array(z.enum(["indeed", "dice"])).min(1).max(2).default(["indeed", "dice"]).optional(),
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  locations: z.array(z.string().trim().min(1).max(200)).min(1).max(10).default(["Remote"]).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
  sourceLimits: sourceLimitsSchema.optional(),
  maxPagesPerSearch: z.number().int().min(1).max(5).optional(),
  maxRuntimeMinutes: z.number().int().min(1).max(30).default(30).optional(),
  minDelayMs: z.number().int().min(5000).max(120000).optional(),
  maxDelayMs: z.number().int().min(5000).max(180000).optional(),
  dryRun: z.boolean().default(false).optional(),
  initialStatus: z.enum(["new", "reviewing"]).default("new").optional(),
}).strict();

type PlaywrightModule = {
  chromium: {
    launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<BrowserContextLike>;
    connectOverCDP: (endpointURL: string) => Promise<BrowserLike>;
  };
};

type BrowserLike = {
  contexts: () => BrowserContextLike[];
  newContext: (options: Record<string, unknown>) => Promise<BrowserContextLike>;
  disconnect?: () => Promise<void> | void;
  close: () => Promise<void>;
};

type BrowserContextLike = {
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
};

type PageLike = {
  goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
  content: () => Promise<string>;
  waitForTimeout: (ms: number) => Promise<void>;
};

type StopReason = "completed" | "canceled" | "time_limit" | "quota_reached";

export async function handleDiscoverJobsBrowser(payload: unknown, context: HandlerContext): Promise<HandlerResult> {
  const cfg = getConfig();
  if (!cfg.JOB_BROWSER_DISCOVERY_ENABLED) {
    throw new Error("Browser discovery is disabled. Set JOB_BROWSER_DISCOVERY_ENABLED=true only on the local machine where you are logged in to job boards.");
  }

  const input = payloadSchema.parse(payload);
  const sources = input.sources ?? ["indeed", "dice"];
  const locations = input.locations ?? ["Remote"];
  const maxResults = Math.min(input.maxResults ?? cfg.JOB_BROWSER_MAX_RESULTS_PER_COMMAND, cfg.JOB_BROWSER_MAX_RESULTS_PER_COMMAND);
  const maxPagesPerSearch = Math.min(input.maxPagesPerSearch ?? cfg.JOB_BROWSER_MAX_PAGES_PER_SEARCH, cfg.JOB_BROWSER_MAX_PAGES_PER_SEARCH);
  const maxRuntimeMinutes = Math.min(input.maxRuntimeMinutes ?? 30, 30);
  const deadlineAt = Date.now() + maxRuntimeMinutes * 60 * 1000;
  const minDelayMs = input.minDelayMs ?? cfg.JOB_BROWSER_MIN_DELAY_MS;
  const maxDelayMs = Math.max(input.maxDelayMs ?? cfg.JOB_BROWSER_MAX_DELAY_MS, minDelayMs);
  const sourceLimits = normalizeSourceLimits(sources, input.sourceLimits, maxResults);
  const foundBySource = Object.fromEntries(sources.map((source) => [source, 0])) as Record<BrowserDiscoverySource, number>;

  const playwright = await loadPlaywright();
  const browserSession = await openBrowserSession(playwright, cfg);
  const contextBrowser = browserSession.context;

  const discovered = new Set<string>();
  const upsertedIds: string[] = [];
  const visitedSearches: string[] = [];
  let stopReason: StopReason = "completed";
  let duplicateCount = 0;

  await addCommandEvent(context.command.id, "browser_discovery_started", "Browser discovery started with a 30-minute maximum runtime cap.", {
    sources,
    queries: input.queries,
    locations,
    maxResults,
    sourceLimits,
    maxRuntimeMinutes,
    delayRangeMs: [minDelayMs, maxDelayMs],
  });

  try {
    const page = await contextBrowser.newPage();
    outer: for (const source of sources) {
      for (const query of input.queries) {
        for (const location of locations) {
          if (foundBySource[source] >= sourceLimits[source]) continue outer;
          const checkpoint = await shouldStop(context.command.id, deadlineAt, discovered.size, maxResults);
          if (checkpoint) {
            stopReason = checkpoint;
            break outer;
          }

          const searchUrl = buildBrowserSearchUrl({ source, query, location });
          visitedSearches.push(searchUrl);
          await addCommandEvent(context.command.id, "browser_discovery_progress", `Searching ${source} for ${query} in ${location}.`, {
            source,
            query,
            location,
            foundSoFar: discovered.size,
            foundBySource,
          });

          await sleep(humanDelayMs({ minDelayMs, maxDelayMs }));
          await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: cfg.JOB_BROWSER_NAVIGATION_TIMEOUT_MS });
          await page.waitForTimeout(humanDelayMs({ minDelayMs, maxDelayMs }));
          const html = await page.content();

          const remainingGlobal = maxResults - discovered.size;
          const remainingSource = sourceLimits[source] - foundBySource[source];
          const urls = extractJobUrlsFromHtml(source, html, searchUrl, Math.max(0, Math.min(remainingGlobal, remainingSource)))
            .filter((url) => !discovered.has(url));
          const existingUrls = input.dryRun ? new Set<string>() : await getExistingUrls(urls);
          duplicateCount += existingUrls.size;

          for (const url of urls) discovered.add(url);
          foundBySource[source] += urls.length;

          let savedThisSearch = 0;
          for (const url of urls) {
            const detailStop = await shouldStop(context.command.id, deadlineAt, 0, Number.MAX_SAFE_INTEGER);
            if (detailStop && detailStop !== "quota_reached") {
              stopReason = detailStop;
              break outer;
            }

            let detailHtml = "";
            let extractionFailed = false;
            try {
              await page.waitForTimeout(humanDelayMs({ minDelayMs, maxDelayMs }));
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.JOB_BROWSER_NAVIGATION_TIMEOUT_MS });
              await page.waitForTimeout(Math.min(humanDelayMs({ minDelayMs, maxDelayMs }), 20000));
              detailHtml = await page.content();
            } catch (error) {
              extractionFailed = true;
              await addCommandEvent(context.command.id, "browser_discovery_detail_failed", "Job detail enrichment failed; saving source URL with fallback metadata.", {
                source,
                query,
                location,
                url,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            const job = extractJobDetail(source, url, detailHtml, { query, location });
            job.status = input.initialStatus ?? "new";
            if (extractionFailed) {
              job.notes = `${job.notes ?? ""} Detail page navigation failed; source URL preserved for manual review.`.trim();
            }
            const upserted = input.dryRun ? [] : await upsertJobs([job]);
            upsertedIds.push(...upserted.map((savedJob) => savedJob.id));
            savedThisSearch += upserted.length;
          }

          await addCommandEvent(context.command.id, "browser_discovery_checkpoint", `Checkpoint saved ${savedThisSearch} ${source} enriched job link(s).`, {
            source,
            query,
            location,
            discoveredThisSearch: urls.length,
            savedThisSearch,
            totalDiscovered: discovered.size,
            totalSaved: upsertedIds.length,
            foundBySource,
          });

          if (maxPagesPerSearch > 1) await page.waitForTimeout(humanDelayMs({ minDelayMs, maxDelayMs }));
        }
      }
    }
  } catch (error) {
    await addCommandEvent(context.command.id, "browser_discovery_failed_gracefully", "Browser discovery stopped after an error; already checkpointed jobs were preserved.", {
      error: error instanceof Error ? error.message : String(error),
      savedBeforeFailure: upsertedIds.length,
      foundBySource,
    });
    throw error;
  } finally {
    await browserSession.close();
  }

  await addCommandEvent(context.command.id, "browser_discovery_finished", `Browser discovery finished with reason: ${stopReason}.`, {
    stopReason,
    discoveredCount: discovered.size,
    savedCount: upsertedIds.length,
    foundBySource,
  });

  return {
    mode: "browser_assisted_human_speed_discovery",
    message: "Discovered individual job links using a local logged-in browser profile at human-like speed. No apply/submit actions were performed.",
    stopReason,
    dryRun: input.dryRun ?? false,
    visitedSearchCount: visitedSearches.length,
    discoveredCount: discovered.size,
    duplicateCount,
    newCount: Math.max(0, discovered.size - duplicateCount),
    upserted: upsertedIds.length,
    sources,
    queries: input.queries,
    locations,
    maxResults,
    sourceLimits,
    foundBySource,
    maxPagesPerSearch,
    maxRuntimeMinutes,
    delayRangeMs: [minDelayMs, maxDelayMs],
    jobIds: upsertedIds,
  };
}

async function openBrowserSession(playwright: PlaywrightModule, cfg: ReturnType<typeof getConfig>) {
  const options = {
    headless: cfg.JOB_BROWSER_HEADLESS,
    slowMo: cfg.JOB_BROWSER_SLOW_MO_MS,
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
  };

  if (cfg.JOB_BROWSER_CDP_URL) {
    const browser = await playwright.chromium.connectOverCDP(cfg.JOB_BROWSER_CDP_URL);
    const context = browser.contexts()[0] ?? (await browser.newContext(options));
    return {
      context,
      close: async () => {
        if (browser.disconnect) await browser.disconnect();
        else await browser.close();
      },
    };
  }

  const context = await playwright.chromium.launchPersistentContext(cfg.JOB_BROWSER_USER_DATA_DIR, options);
  return { context, close: () => context.close() };
}

function normalizeSourceLimits(
  sources: BrowserDiscoverySource[],
  sourceLimits: Partial<Record<BrowserDiscoverySource, number>> | undefined,
  maxResults: number,
) {
  const fallback = Math.ceil(maxResults / sources.length);
  return Object.fromEntries(sources.map((source) => [source, Math.min(sourceLimits?.[source] ?? fallback, maxResults)])) as Record<BrowserDiscoverySource, number>;
}

async function shouldStop(
  commandId: string,
  deadlineAt: number,
  discoveredCount: number,
  maxResults: number,
): Promise<StopReason | null> {
  if (Date.now() >= deadlineAt) return "time_limit";
  const status = await getCommandStatus(commandId);
  if (status === "canceled") return "canceled";
  if (discoveredCount >= maxResults) return "quota_reached";
  return null;
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<PlaywrightModule>;
    return await dynamicImport("playwright");
  } catch {
    throw new Error("Playwright is required for browser discovery. Install it on the local worker machine with: npm install -D playwright && npx playwright install chromium");
  }
}
