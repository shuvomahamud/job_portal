import { z } from "zod";
import { getConfig, sleep } from "../config";
import {
  addCommandEvent,
  getCommandStatus,
  getExistingUrls,
  getJobsBySourceUrls,
  upsertJobs,
} from "../db";
import {
  buildBrowserSearchPageUrl,
  buildDiscoveredJobRecords,
  extractJobUrlsFromHtml,
  humanDelayMs,
  type BrowserDiscoverySource,
} from "../search/browserDiscovery";
import { extractJobDetail } from "../search/jobDetailExtraction";
import { MAX_DISCOVERY_RESULTS_PER_COMMAND } from "../search/discoveryLimits";
import { loadPlaywright, openBrowserSession } from "../browser/session";
import type { PageLike } from "../browser/playwrightTypes";
import { logger } from "../logger";
import {
  BrowserInterventionRequiredError,
  detectBrowserBlocker,
} from "../browser/blockerDetection";
import { reportBrowserBlocker } from "../browser/reportBlocker";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";

const sourceLimitsSchema = z
  .object({
    indeed: z.number().int().min(0).max(MAX_DISCOVERY_RESULTS_PER_COMMAND).optional(),
    dice: z.number().int().min(0).max(MAX_DISCOVERY_RESULTS_PER_COMMAND).optional(),
  })
  .strict();

export const payloadSchema = z.object({
  sources: z.array(z.enum(["indeed", "dice"])).min(1).max(2).default(["indeed", "dice"]).optional(),
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  locations: z.array(z.string().trim().min(1).max(200)).min(1).max(10).default(["Remote"]).optional(),
  maxResults: z.number().int().min(1).max(MAX_DISCOVERY_RESULTS_PER_COMMAND).optional(),
  sourceLimits: sourceLimitsSchema.optional(),
  maxPagesPerSearch: z.number().int().min(1).max(10).optional(),
  maxRuntimeMinutes: z.number().int().min(1).max(240).optional(),
  minDelayMs: z.number().int().min(5000).max(120000).optional(),
  maxDelayMs: z.number().int().min(5000).max(180000).optional(),
  dryRun: z.boolean().default(false).optional(),
  initialStatus: z.enum(["new", "reviewing"]).default("new").optional(),
}).strict();

type StopReason = "completed" | "canceled" | "time_limit" | "quota_reached";

/**
 * Lets the caller react while discovery is still running.
 *
 * Discovery is generic and knows nothing about roles or resumes, but it is the only place
 * that knows when postings land. Scoring has to start during the search rather than after
 * it, so the caller — which does know the role — supplies the reaction.
 */
export type DiscoveryHooks = {
  /** Called each time newly staged postings push the running total past another batch. */
  onJobsStaged?: (stagedTotal: number) => Promise<void>;
};

/** Postings staged between scoring nudges. */
const SCORING_NUDGE_BATCH = 10;

export async function handleDiscoverJobsBrowser(
  payload: unknown,
  context: HandlerContext,
  hooks: DiscoveryHooks = {},
): Promise<HandlerResult> {
  const cfg = getConfig();
  const userId = requireCommandUserId(context.command.requestedBy);
  if (!cfg.JOB_BROWSER_DISCOVERY_ENABLED) {
    throw new Error("Browser discovery is disabled. Set JOB_BROWSER_DISCOVERY_ENABLED=true only on the local machine where you are logged in to job boards.");
  }

  const input = payloadSchema.parse(payload);
  const sources = input.sources ?? ["indeed", "dice"];
  const locations = input.locations ?? ["Remote"];
  const maxResults = input.maxResults ?? cfg.JOB_BROWSER_MAX_RESULTS_PER_COMMAND;
  const maxPagesPerSearch = Math.min(input.maxPagesPerSearch ?? cfg.JOB_BROWSER_MAX_PAGES_PER_SEARCH, cfg.JOB_BROWSER_MAX_PAGES_PER_SEARCH);
  const maxRuntimeMinutes = Math.min(
    input.maxRuntimeMinutes ?? Math.max(30, Math.ceil(maxResults / 20) * 10),
    240,
  );
  const deadlineAt = Date.now() + maxRuntimeMinutes * 60 * 1000;
  const minDelayMs = input.minDelayMs ?? cfg.JOB_BROWSER_MIN_DELAY_MS;
  const maxDelayMs = Math.max(input.maxDelayMs ?? cfg.JOB_BROWSER_MAX_DELAY_MS, minDelayMs);
  const sourceLimits = normalizeSourceLimits(sources, input.sourceLimits, maxResults);
  const foundBySource = Object.fromEntries(sources.map((source) => [source, 0])) as Record<BrowserDiscoverySource, number>;

  const playwright = await loadPlaywright();
  const browserSession = await openBrowserSession(playwright, cfg);
  const contextBrowser = browserSession.context;

  const discovered = new Set<string>();
  const seenUrls = new Set<string>();
  const upsertedIds = new Set<string>();
  const visitedSearches: string[] = [];
  let stopReason: StopReason = "completed";
  let duplicateCount = 0;
  let stagedSinceNudge = 0;
  let stagedTotal = 0;
  let page: PageLike | null = null;

  try {
    await addCommandEvent(context.command.id, "browser_discovery_started", "Browser discovery started with a 30-minute maximum runtime cap.", {
      sources,
      queries: input.queries,
      locations,
      maxResults,
      sourceLimits,
      maxRuntimeMinutes,
      delayRangeMs: [minDelayMs, maxDelayMs],
      cdpCleanup: browserSession.cdpCleanup,
    });

    page = await contextBrowser.newPage();
    outer: for (const source of sources) {
      for (const query of input.queries) {
        for (const location of locations) {
          for (let searchPage = 1; searchPage <= maxPagesPerSearch; searchPage += 1) {
            if (foundBySource[source] >= sourceLimits[source]) continue outer;
            const checkpoint = await shouldStop(
              context.command.id,
              deadlineAt,
              discovered.size,
              maxResults,
              context.claimGuard,
            );
            if (checkpoint) {
              stopReason = checkpoint;
              break outer;
            }

            const searchUrl = buildBrowserSearchPageUrl(
              { source, query, location },
              searchPage,
            );
            visitedSearches.push(searchUrl);
            await addCommandEvent(
              context.command.id,
              "browser_discovery_progress",
              `Searching ${source} for ${query} in ${location} (page ${searchPage}).`,
              { source, query, location, searchPage, foundSoFar: discovered.size, foundBySource },
            );

            await sleep(humanDelayMs({ minDelayMs, maxDelayMs }));
            await page.goto(searchUrl, {
              waitUntil: "domcontentloaded",
              timeout: cfg.JOB_BROWSER_NAVIGATION_TIMEOUT_MS,
            });
            await page.waitForTimeout(Math.min(humanDelayMs({ minDelayMs, maxDelayMs }), 15_000));
            const blocker = await detectBrowserBlocker(page, source);
            if (blocker) {
              await reportBrowserBlocker({ commandId: context.command.id, userId, blocker, cfg });
              throw new BrowserInterventionRequiredError(
                `${blocker.message} Use “Open browser to unblock” on the dashboard, then run the cycle again.`,
              );
            }

            const html = await page.content();
            const remainingGlobal = maxResults - discovered.size;
            const remainingSource = sourceLimits[source] - foundBySource[source];
            const urls = extractJobUrlsFromHtml(
              source,
              html,
              searchUrl,
              Math.min(200, Math.max(remainingGlobal, remainingSource) + 50),
            ).filter((url) => !seenUrls.has(url));
            if (!urls.length) break;
            for (const url of urls) seenUrls.add(url);

            const existingUrls = input.dryRun ? new Set<string>() : await getExistingUrls(urls);
            const newUrls = urls
              .filter((url) => !existingUrls.has(url))
              .slice(0, Math.max(0, Math.min(remainingGlobal, remainingSource)));
            duplicateCount += existingUrls.size;
            for (const url of newUrls) discovered.add(url);
            foundBySource[source] += newUrls.length;

            if (!input.dryRun && existingUrls.size) {
              const existingJobs = await getJobsBySourceUrls([...existingUrls]);
              for (const job of existingJobs) upsertedIds.add(job.id);
            }

            // Stage new links before detail enrichment so the board updates while the
            // slower browser work is still running. Existing rows are never overwritten
            // with fallback metadata.
            if (!input.dryRun && newUrls.length) {
              const staged = await upsertJobs(
                buildDiscoveredJobRecords(source, newUrls, { query, location }).map((job) => ({
                  ...job,
                  status: input.initialStatus ?? "new",
                })),
              );
              await addCommandEvent(
                context.command.id,
                "browser_discovery_links_staged",
                `Added ${staged.length} new ${source} link(s) to the board before enrichment.`,
                { source, query, location, searchPage, jobIds: staged.map((job) => job.id) },
              );

              stagedSinceNudge += staged.length;
              stagedTotal += staged.length;
              if (stagedSinceNudge >= SCORING_NUDGE_BATCH && hooks.onJobsStaged) {
                stagedSinceNudge = 0;
                // Never let a scoring nudge take the search down with it.
                try {
                  await hooks.onJobsStaged(stagedTotal);
                } catch (error) {
                  logger.warn("Scoring nudge failed during discovery", {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }

            let savedThisPage = 0;
            for (const url of newUrls) {
              const detailStop = await shouldStop(
                context.command.id,
                deadlineAt,
                0,
                Number.MAX_SAFE_INTEGER,
                context.claimGuard,
              );
              if (detailStop && detailStop !== "quota_reached") {
                stopReason = detailStop;
                break outer;
              }

              let detailHtml = "";
              let extractionFailed = false;
              try {
                await page.waitForTimeout(
                  humanDelayMs({
                    minDelayMs: Math.min(minDelayMs, 5_000),
                    maxDelayMs: Math.min(maxDelayMs, 12_000),
                  }),
                );
                await page.goto(url, {
                  waitUntil: "domcontentloaded",
                  timeout: cfg.JOB_BROWSER_NAVIGATION_TIMEOUT_MS,
                });
                await page.waitForTimeout(3_000);
                const detailBlocker = await detectBrowserBlocker(page, source);
                if (detailBlocker) {
                  await reportBrowserBlocker({
                    commandId: context.command.id,
                    userId,
                    blocker: detailBlocker,
                    cfg,
                  });
                  throw new BrowserInterventionRequiredError(
                    `${detailBlocker.message} Use “Open browser to unblock” on the dashboard, then run the cycle again.`,
                  );
                }
                detailHtml = await page.content();
              } catch (error) {
                if (error instanceof BrowserInterventionRequiredError) throw error;
                extractionFailed = true;
                await addCommandEvent(
                  context.command.id,
                  "browser_discovery_detail_failed",
                  "Job detail enrichment failed; the staged source URL was preserved.",
                  {
                    source,
                    query,
                    location,
                    url,
                    error: error instanceof Error ? error.message : String(error),
                  },
                );
              }

              const job = extractJobDetail(source, url, detailHtml, { query, location });
              job.status = input.initialStatus ?? "new";
              if (extractionFailed) {
                job.notes = `${job.notes ?? ""} Detail page navigation failed; source URL preserved for manual review.`.trim();
              }
              const upserted = input.dryRun ? [] : await upsertJobs([job]);
              for (const savedJob of upserted) upsertedIds.add(savedJob.id);
              savedThisPage += upserted.length;
            }

            await addCommandEvent(
              context.command.id,
              "browser_discovery_checkpoint",
              `Checkpoint enriched ${savedThisPage} new ${source} job(s).`,
              {
                source,
                query,
                location,
                searchPage,
                discoveredThisPage: newUrls.length,
                duplicatesThisPage: existingUrls.size,
                savedThisPage,
                totalDiscovered: discovered.size,
                totalSaved: upsertedIds.size,
                foundBySource,
              },
            );
          }
        }
      }
    }
  } catch (error) {
    await addCommandEvent(context.command.id, "browser_discovery_failed_gracefully", "Browser discovery stopped after an error; already checkpointed jobs were preserved.", {
      error: error instanceof Error ? error.message : String(error),
      savedBeforeFailure: upsertedIds.size,
      foundBySource,
    });
    throw error;
  } finally {
    if (page) {
      try {
        await page.close({ runBeforeUnload: false });
      } catch (error) {
        logger.warn("Could not close the browser discovery page", {
          commandId: context.command.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await browserSession.close();
    } catch (error) {
      logger.warn("Could not disconnect the browser discovery session", {
        commandId: context.command.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await addCommandEvent(context.command.id, "browser_discovery_finished", `Browser discovery finished with reason: ${stopReason}.`, {
    stopReason,
    discoveredCount: discovered.size,
    savedCount: upsertedIds.size,
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
    newCount: discovered.size,
    upserted: upsertedIds.size,
    sources,
    queries: input.queries,
    locations,
    maxResults,
    sourceLimits,
    foundBySource,
    maxPagesPerSearch,
    maxRuntimeMinutes,
    delayRangeMs: [minDelayMs, maxDelayMs],
    jobIds: [...upsertedIds],
  };
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
  claimGuard?: { lost: boolean },
): Promise<StopReason | null> {
  if (claimGuard?.lost) return "canceled";
  if (Date.now() >= deadlineAt) return "time_limit";
  const status = await getCommandStatus(commandId);
  if (status === "canceled") return "canceled";
  if (discoveredCount >= maxResults) return "quota_reached";
  return null;
}
