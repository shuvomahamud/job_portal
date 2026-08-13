import { z } from "zod";
import { detectBrowserBlocker, isLoginUrl } from "../browser/blockerDetection";
import { loadPlaywright, openBrowserSession } from "../browser/session";
import { getConfig, sleep } from "../config";
import {
  addCommandEvent,
  getAutomationAlertForUser,
  getCommandStatus,
  resumeCommandAfterBrowserIntervention,
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
const CLEAN_CHECKS_BEFORE_RELOAD = 3;
const CLEAN_CHECKS_AFTER_RELOAD = 5;

export type AccessVerificationState = {
  phase: "before_reload" | "after_reload";
  cleanChecks: number;
};

export function advanceAccessVerification(
  state: AccessVerificationState,
  accessIsClear: boolean,
): { state: AccessVerificationState; action: "wait" | "reload" | "verified" } {
  if (!accessIsClear) {
    return {
      state: { phase: "before_reload", cleanChecks: 0 },
      action: "wait",
    };
  }

  const cleanChecks = state.cleanChecks + 1;
  if (state.phase === "before_reload" && cleanChecks >= CLEAN_CHECKS_BEFORE_RELOAD) {
    return {
      state: { phase: "after_reload", cleanChecks: 0 },
      action: "reload",
    };
  }
  if (state.phase === "after_reload" && cleanChecks >= CLEAN_CHECKS_AFTER_RELOAD) {
    return {
      state: { phase: "after_reload", cleanChecks },
      action: "verified",
    };
  }
  return { state: { ...state, cleanChecks }, action: "wait" };
}

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
  const verification = new Map<string, AccessVerificationState>(
    input.sites.map((site) => [site, { phase: "before_reload", cleanChecks: 0 }]),
  );
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
        if (!page) {
          cleared.delete(site);
          verification.set(site, { phase: "before_reload", cleanChecks: 0 });
          continue;
        }
        const blocker = await detectBrowserBlocker(page, site);
        const step = advanceAccessVerification(
          verification.get(site) ?? { phase: "before_reload", cleanChecks: 0 },
          !blocker && !isLoginUrl(page.url()),
        );
        verification.set(site, step.state);

        if (step.action === "reload") {
          cleared.delete(site);
          const verificationUrl = alert?.site === site && alert.pageUrl
            ? alert.pageUrl
            : page.url();
          await addCommandEvent(
            context.command.id,
            "interactive_browser_verification_reload",
            `The challenge disappeared for ${site}; reloading the target page to confirm the clearance persists.`,
            { site, verificationUrl },
          );
          const reloadSucceeded = await page.goto(verificationUrl, {
            waitUntil: "domcontentloaded",
            timeout: cfg.JOB_BROWSER_NAVIGATION_TIMEOUT_MS,
          }).then(() => true).catch(() => false);
          if (!reloadSucceeded) {
            verification.set(site, { phase: "before_reload", cleanChecks: 0 });
          }
          continue;
        }

        if (step.action === "verified") cleared.add(site);
        else cleared.delete(site);
      }

      if (input.sites.every((site) => cleared.has(site))) {
        const resolved = await resolveAutomationAlerts(userId, input.sites);
        const resumed = alert?.commandId
          ? await resumeCommandAfterBrowserIntervention(alert.commandId, userId)
          : null;
        await addCommandEvent(
          context.command.id,
          "interactive_browser_unblocked",
          `Verified durable access for ${input.sites.join(", ")}; the worker profile is ready.`,
          {
            sites: input.sites,
            resolvedAlertIds: resolved.map((row) => row.id),
            resumedCommandId: resumed?.id ?? null,
          },
        );
        return {
          sites: input.sites,
          verified: true,
          resolvedAlerts: resolved.length,
          resumedCommandId: resumed?.id ?? null,
          message: resumed
            ? "Verification persisted after reload. The blocked work was queued to resume automatically."
            : "Verification persisted after reload. The worker browser profile is ready.",
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
