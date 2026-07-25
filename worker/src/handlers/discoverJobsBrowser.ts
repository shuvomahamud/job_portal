import { z } from "zod";
import { getConfig, sleep } from "../config";
import { upsertJobs } from "../db";
import {
  buildBrowserSearchUrl,
  buildDiscoveredJobRecords,
  extractJobUrlsFromHtml,
  humanDelayMs,
  type BrowserDiscoverySource,
} from "../search/browserDiscovery";
import type { HandlerResult } from "../types";

const payloadSchema = z.object({
  sources: z.array(z.enum(["linkedin", "indeed", "dice"])).min(1).max(3).default(["linkedin", "indeed", "dice"]).optional(),
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  locations: z.array(z.string().trim().min(1).max(200)).min(1).max(10).default(["Remote"]).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
  maxPagesPerSearch: z.number().int().min(1).max(5).optional(),
  minDelayMs: z.number().int().min(5000).max(120000).optional(),
  maxDelayMs: z.number().int().min(5000).max(180000).optional(),
  dryRun: z.boolean().default(false).optional(),
}).strict();

type PlaywrightModule = {
  chromium: {
    launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<BrowserContextLike>;
  };
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

export async function handleDiscoverJobsBrowser(payload: unknown): Promise<HandlerResult> {
  const cfg = getConfig();
  if (!cfg.JOB_BROWSER_DISCOVERY_ENABLED) {
    throw new Error("Browser discovery is disabled. Set JOB_BROWSER_DISCOVERY_ENABLED=true only on the local machine where you are logged in to job boards.");
  }

  const input = payloadSchema.parse(payload);
  const sources = input.sources ?? ["linkedin", "indeed", "dice"];
  const locations = input.locations ?? ["Remote"];
  const maxResults = Math.min(input.maxResults ?? cfg.JOB_BROWSER_MAX_RESULTS_PER_COMMAND, cfg.JOB_BROWSER_MAX_RESULTS_PER_COMMAND);
  const maxPagesPerSearch = Math.min(input.maxPagesPerSearch ?? cfg.JOB_BROWSER_MAX_PAGES_PER_SEARCH, cfg.JOB_BROWSER_MAX_PAGES_PER_SEARCH);
  const minDelayMs = input.minDelayMs ?? cfg.JOB_BROWSER_MIN_DELAY_MS;
  const maxDelayMs = Math.max(input.maxDelayMs ?? cfg.JOB_BROWSER_MAX_DELAY_MS, minDelayMs);

  const playwright = await loadPlaywright();
  const context = await playwright.chromium.launchPersistentContext(cfg.JOB_BROWSER_USER_DATA_DIR, {
    headless: cfg.JOB_BROWSER_HEADLESS,
    slowMo: cfg.JOB_BROWSER_SLOW_MO_MS,
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
  });

  const discovered = new Map<string, { source: BrowserDiscoverySource; query: string; location?: string }>();
  const visitedSearches: string[] = [];

  try {
    const page = await context.newPage();
    for (const source of sources) {
      for (const query of input.queries) {
        for (const location of locations) {
          if (discovered.size >= maxResults) break;
          const searchUrl = buildBrowserSearchUrl({ source, query, location });
          visitedSearches.push(searchUrl);
          await sleep(humanDelayMs({ minDelayMs, maxDelayMs }));
          await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: cfg.JOB_BROWSER_NAVIGATION_TIMEOUT_MS });
          await page.waitForTimeout(humanDelayMs({ minDelayMs, maxDelayMs }));
          const html = await page.content();
          const urls = extractJobUrlsFromHtml(source, html, searchUrl, maxResults - discovered.size);
          for (const url of urls) discovered.set(url, { source, query, location });

          // Phase 2B intentionally stays conservative: we collect page-one result links first.
          // maxPagesPerSearch is kept in the command shape so we can add source-specific next-page navigation later without changing the API.
          if (maxPagesPerSearch > 1) await page.waitForTimeout(humanDelayMs({ minDelayMs, maxDelayMs }));
        }
      }
    }
  } finally {
    await context.close();
  }

  const jobs = Array.from(discovered.entries()).flatMap(([url, spec]) => buildDiscoveredJobRecords(spec.source, [url], spec));
  const upserted = input.dryRun ? [] : await upsertJobs(jobs);

  return {
    mode: "browser_assisted_human_speed_discovery",
    message: "Discovered individual job links using a local logged-in browser profile at human-like speed. No apply/submit actions were performed.",
    dryRun: input.dryRun ?? false,
    visitedSearchCount: visitedSearches.length,
    discoveredCount: jobs.length,
    upserted: upserted.length,
    sources,
    queries: input.queries,
    locations,
    maxResults,
    maxPagesPerSearch,
    delayRangeMs: [minDelayMs, maxDelayMs],
    jobIds: upserted.map((job) => job.id),
  };
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<PlaywrightModule>;
    return await dynamicImport("playwright");
  } catch {
    throw new Error("Playwright is required for browser discovery. Install it on the local worker machine with: npm install -D playwright && npx playwright install chromium");
  }
}
