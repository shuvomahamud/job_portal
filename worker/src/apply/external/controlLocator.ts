/**
 * Finding the control that moves an unfamiliar form forward.
 *
 * On Indeed and Dice this is a solved problem: the adapter knows the button, and paying a
 * model to rediscover it every time would be pure waste. An employer's own site is the
 * opposite — there is no adapter, the markup is unseen, and a deterministic guess based on
 * button wording is exactly the kind of thing that quietly picks "Save and close" instead
 * of "Continue".
 *
 * So the two are separated behind one interface, and the executor chooses per site rather
 * than one strategy being declared better everywhere.
 *
 * What never moves is the boundary: a locator says *where* a control is. It does not
 * decide what a field's value should be — that comes from the answer bank and the risk
 * policy — and it does not decide whether a submit may be clicked, which is the
 * submission guard's job alone.
 */
import type { FrameLike, PageLike } from "../../browser/playwrightTypes";

export type LocatedControl = {
  /** How the executor will click it. */
  locator: unknown;
  /** True when clicking this finishes the application rather than advancing a step. */
  isTerminalSubmit: boolean;
  /** Visible label, for the trace and for the submission guard's sanity check. */
  label: string;
  /** Whether a model chose this, which the submission guard weighs. */
  proposedByModel: boolean;
};

export interface ControlLocator {
  readonly name: "deterministic" | "model";
  findAdvanceControl(frame: FrameLike, page: PageLike): Promise<LocatedControl | null>;
}

/** Wording that finishes an application, checked before wording that merely advances. */
export const TERMINAL_CONTROL_NAME =
  /submit (your |my )?application|send application|^submit$/i;
export const ADVANCE_CONTROL_NAME = /continue|next|save and continue|review|proceed/i;

/**
 * Deliberately excluded, because they look like progress and are not.
 *
 * "Save and close" reads like a normal advance control and abandons the application;
 * Indeed puts one directly above the real button on every step.
 *
 * "Preview next page" is the PDF carousel on Indeed's resume step. A `/next/` name
 * match was taking that instead of Continue, paging the resume, then stalling.
 */
const NOT_ADVANCE =
  /save and close|save for later|cancel|back|previous|sign in|create account|preview|carousel|next page|previous page/i;

export function classifyControlLabel(
  label: string,
): { advances: boolean; isTerminalSubmit: boolean } {
  const clean = label.trim();
  if (!clean || NOT_ADVANCE.test(clean)) return { advances: false, isTerminalSubmit: false };
  if (TERMINAL_CONTROL_NAME.test(clean)) return { advances: true, isTerminalSubmit: true };
  if (ADVANCE_CONTROL_NAME.test(clean)) return { advances: true, isTerminalSubmit: false };
  return { advances: false, isTerminalSubmit: false };
}
