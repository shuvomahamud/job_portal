import type { WorkerConfig } from "../config";
import { logger } from "../logger";
import { prepareManagedCdpBrowser, type CdpCleanupResult } from "../search/cdpBrowser";
import type { BrowserContextLike, BrowserLike, PlaywrightModule } from "./playwrightTypes";

export type BrowserSession = {
  context: BrowserContextLike;
  /** Non-null only when JOB_BROWSER_CDP_MANAGE_PAGES closed stale tabs before connecting. */
  cdpCleanup: { closedPageCount: number } | null;
  close: () => Promise<void>;
};

export async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<PlaywrightModule>;
    return await dynamicImport("playwright");
  } catch {
    throw new Error(
      "Playwright is required for browser automation. Install it on the local worker machine with: npm install -D playwright && npx playwright install chromium",
    );
  }
}

export async function openBrowserSession(
  playwright: PlaywrightModule,
  cfg: WorkerConfig,
): Promise<BrowserSession> {
  const contextOptions = {
    headless: cfg.JOB_BROWSER_HEADLESS,
    slowMo: cfg.JOB_BROWSER_SLOW_MO_MS,
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
  };

  if (cfg.JOB_BROWSER_CDP_URL) {
    let lastError: unknown;
    const maxAttempts = cfg.JOB_BROWSER_CDP_MANAGE_PAGES ? 2 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let cdpCleanup: CdpCleanupResult | null = null;
      let browser: BrowserLike | null = null;
      try {
        if (cfg.JOB_BROWSER_CDP_MANAGE_PAGES) {
          cdpCleanup = await prepareManagedCdpBrowser(cfg.JOB_BROWSER_CDP_URL, {
            requestTimeoutMs: cfg.JOB_BROWSER_CDP_CLEANUP_TIMEOUT_MS,
            settleTimeoutMs: cfg.JOB_BROWSER_CDP_CLEANUP_TIMEOUT_MS,
          });
          logger.info("Prepared dedicated Chrome CDP browser", {
            attempt,
            closedPageCount: cdpCleanup.closedTargetIds.length,
          });
        }

        // slowMo belongs on the connect call. Passing it only through newContext is a
        // no-op on the CDP path, and when an existing context is reused the options
        // object is dropped entirely.
        const connectedBrowser = await playwright.chromium.connectOverCDP(cfg.JOB_BROWSER_CDP_URL, {
          timeout: cfg.JOB_BROWSER_CDP_CONNECT_TIMEOUT_MS,
          slowMo: cfg.JOB_BROWSER_SLOW_MO_MS,
        });
        browser = connectedBrowser;
        const context = connectedBrowser.contexts()[0] ?? (await connectedBrowser.newContext(contextOptions));
        return {
          context,
          cdpCleanup: cdpCleanup ? { closedPageCount: cdpCleanup.closedTargetIds.length } : null,
          close: async () => {
            if (connectedBrowser.disconnect) await connectedBrowser.disconnect();
            else await connectedBrowser.close();
          },
        };
      } catch (error) {
        lastError = error;
        if (browser) {
          try {
            if (browser.disconnect) await browser.disconnect();
            else await browser.close();
          } catch {
            // The connection already failed; the retry below performs a fresh cleanup.
          }
        }
        logger.warn("Could not connect to Chrome CDP browser", {
          attempt,
          maxAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw new Error(
      `Could not connect to Chrome CDP browser after ${maxAttempts} attempt(s): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  const context = await playwright.chromium.launchPersistentContext(
    cfg.JOB_BROWSER_USER_DATA_DIR,
    contextOptions,
  );
  return { context, cdpCleanup: null, close: () => context.close() };
}
