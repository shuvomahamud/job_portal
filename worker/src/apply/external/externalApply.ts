/**
 * The employer-site behaviour, gathered in one place and reached from the ordinary runner.
 *
 * Deliberately not a second apply loop. The existing runner already carries everything
 * that matters — the answer bank, the risk policy, resume attachment, blocker detection,
 * artifacts, the pending-question flow — and a parallel implementation would have to keep
 * all of it in step forever. What an employer's site actually needs is different answers to
 * three questions the runner already asks: what kind of page is this, where is the control
 * that advances it, and may this submit be clicked.
 */
import { classifyPage, needsHuman, type PageKind, type PageSignals } from "./pageClassifier";
import { classifyControlLabel } from "./controlLocator";
import { createStagehandLocator } from "./stagehandLocator";
import { logger } from "../../logger";
import type { FrameLike, PageLike } from "../../browser/playwrightTypes";

export { needsHuman };
export type { PageKind };

/** A control to click, however it was found. */
export type ExternalControl = {
  /** Set when a model proposed it; resolved against the frame by the caller. */
  selector: string | null;
  /** Set when the deterministic adapter found it. */
  locator: unknown | null;
  isTerminalSubmit: boolean;
  label: string;
  proposedByModel: boolean;
};

/**
 * Reads the page signals the classifier needs.
 *
 * A password field is checked by selector rather than inferred from wording, because it is
 * the only reliable way to tell "make an account" from "sign in to one you have".
 */
export async function gatherPageSignals(
  page: PageLike,
  fieldCount: number,
): Promise<PageSignals> {
  const text = (await page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""))
    .replace(/\s+/g, " ")
    .slice(0, 20_000);
  const passwordCount = await page
    .locator('input[type="password"]')
    .count()
    .catch(() => 0);
  return {
    url: page.url(),
    text,
    hasPasswordField: passwordCount > 0,
    fieldCount,
  };
}

export async function classifyExternalPage(
  page: PageLike,
  fieldCount: number,
): Promise<PageKind> {
  return classifyPage(await gatherPageSignals(page, fieldCount));
}

/**
 * Finds the control that advances an employer's form, model first.
 *
 * The order is the opposite of the job boards, on purpose. Indeed and Dice are rehearsed,
 * so paying inference to rediscover a known button on every application would give back
 * the pacing work outright. An employer's form has no adapter and has never been seen, and
 * there a deterministic guess from button wording is exactly what picks "Save and close"
 * instead of "Continue".
 *
 * The deterministic finder still runs when the model declines or is switched off, so the
 * capability degrades rather than disappearing.
 */
export async function findExternalAdvanceControl(
  frame: FrameLike,
  page: PageLike,
  deterministic: () => Promise<{ locator: unknown; isTerminalSubmit: boolean } | null>,
): Promise<ExternalControl | null> {
  try {
    const proposed = await createStagehandLocator().findAdvanceControl(frame, page);
    if (proposed?.locator) {
      logger.info("Model proposed an advance control", {
        label: proposed.label,
        isTerminalSubmit: proposed.isTerminalSubmit,
      });
      return {
        selector: String(proposed.locator),
        locator: null,
        isTerminalSubmit: proposed.isTerminalSubmit,
        label: proposed.label,
        proposedByModel: true,
      };
    }
  } catch (error) {
    // Never fatal: the deterministic finder below is the floor, not a bonus.
    logger.warn("Model control location failed; using the deterministic finder", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const found = await deterministic();
  if (!found) return null;
  return {
    selector: null,
    locator: found.locator,
    isTerminalSubmit: found.isTerminalSubmit,
    label: "",
    proposedByModel: false,
  };
}

/**
 * Whether a control the model proposed still looks safe to treat as terminal.
 *
 * Re-derived from the label rather than trusted, so a model that calls "Save and close" a
 * submit cannot make it one.
 */
export function controlIsSafeToSubmit(control: ExternalControl): boolean {
  if (!control.proposedByModel) return control.isTerminalSubmit;
  return classifyControlLabel(control.label).isTerminalSubmit;
}
