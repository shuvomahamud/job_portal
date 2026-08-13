import { z } from "zod";
import { detectBrowserBlocker, isLoginUrl } from "../browser/blockerDetection";
import { loadPlaywright, openBrowserSession } from "../browser/session";
import { getConfig, sleep } from "../config";
import {
  addCommandEvent,
  getAutomationAlertForUser,
  getCommandStatus,
  resolveAutomationAlerts,
} from "../db";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";

const payloadSchema = z
  .object({
    sites: z.array(z.enum(["indeed", "dice", "linkedin"])).min(1).max(3),
    alertId: z.string().uuid().optional(),
  })
  .strict();

const LOGIN_URLS = {
  indeed: "https://secure.indeed.com/account/login",
  dice: "https://www.dice.com/dashboard/login",
  linkedin: "https://www.linkedin.com/login",
} as const;

const MAX_INTERACTIVE_MINUTES = 30;

export async function handleOpenBrowserLogin(
  payload: unknown,
  context: HandlerContext,
): Promise<HandlerResult> {
  const input = payloadSchema.parse(payload);
  const userId = requireCommandUserId(context.command.requestedBy);
  const cfg = getConfig();
  const playwright = await loadPlaywright();
  const session = await openBrowserSession(playwright, cfg, { headless: false });
  const alert = input.alertId
    ? await getAutomationAlertForUser(input.alertId, userId)
    : null;
  const cleared = new Set<string>();
  const deadline = Date.now() + MAX_INTERACTIVE_MINUTES * 60_000;

  try {
    for (const [index, site] of input.sites.entries()) {
      const page = index === 0
        ? session.context.pages()[0] ?? (await session.context.newPage())
        : await session.context.newPage();
      const alertUrl = alert?.site === site ? alert.pageUrl : null;
      await page.goto(alertUrl || LOGIN_URLS[site], {
        waitUntil: "domcontentloaded",
        timeout: cfg.JOB_BROWSER_NAVIGATION_TIMEOUT_MS,
      });
    }

    await addCommandEvent(
      context.command.id,
      "interactive_browser_opened",
      `Opened a visible browser for ${input.sites.join(", ")}.`,
      { sites: input.sites, alertId: input.alertId ?? null },
    );

    while (Date.now() < deadline && !context.claimGuard.lost) {
      if ((await getCommandStatus(context.command.id)) === "canceled") break;
      const pages = session.context.pages();
      if (!pages.length) break;

      for (const site of input.sites) {
        const page = pages.find((candidate) => candidate.url().includes(site));
        if (!page) continue;
        const blocker = await detectBrowserBlocker(page, site);
        if (!blocker && !isLoginUrl(page.url())) cleared.add(site);
      }

      if (input.sites.every((site) => cleared.has(site))) {
        const resolved = await resolveAutomationAlerts(userId, input.sites);
        await addCommandEvent(
          context.command.id,
          "interactive_browser_unblocked",
          `Verified access for ${input.sites.join(", ")}; the worker profile is ready.`,
          { sites: input.sites, resolvedAlertIds: resolved.map((row) => row.id) },
        );
        return {
          sites: input.sites,
          verified: true,
          resolvedAlerts: resolved.length,
          message: "Login or verification completed. You can run the apply cycle again.",
        };
      }
      await sleep(2_000);
    }

    return {
      sites: input.sites,
      verified: false,
      message: "The browser closed or timed out before access could be verified; the alert remains open.",
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}
