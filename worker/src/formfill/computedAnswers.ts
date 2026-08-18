/**
 * Questions that are not really questions — the answer is a computation, not a fact about
 * the candidate, and must be produced fresh every time rather than looked up.
 *
 * "Today's Date" is the evidenced case: it sat as an open pending question on a real
 * application. It is not unknown in the sense the answer bank or an AI retrieval step
 * means by unknown — nobody needs to remember it, because it is never the same thing
 * twice. Answering it once and letting the bank cache the reply, the way every other
 * pending question is meant to work, produces something worse than an unanswered field: a
 * form silently signed with a date from a previous run.
 *
 * Single source of truth on purpose. This used to be duplicated — a matching regex and a
 * formatter lived directly in applyPolicy.ts's decideFieldAction, close to where the
 * "today's date" fill decision is made — and a second one very nearly grew up here
 * alongside it, with a subtly different, unpadded format ("8/5/2026" against the original's
 * "08/05/2026"). Two answers for the same question is exactly the kind of drift this module
 * exists to prevent; decideFieldAction now calls into this file rather than compute its own.
 */
import type { DetectedField } from "./types";

export type ComputedAnswer = {
  value: string;
  reason: string;
};

const TODAYS_DATE_QUESTION =
  /\btoday'?s date\b|\bcurrent date\b|\bdate of (this )?(application|signature)\b|\bdate signed\b/i;

/**
 * True for a question this module can compute, whether or not it is being computed right
 * now — used defensively at the point a human-typed answer would otherwise be cached, so a
 * date typed in today cannot be replayed as though it were typed tomorrow.
 */
export function isComputedQuestion(labelText: string): boolean {
  return TODAYS_DATE_QUESTION.test(labelText.trim());
}

/** MM/DD/YYYY, zero-padded — matches the format already live in decideFieldAction. */
function formatUsDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}/${day}/${date.getFullYear()}`;
}

/** The one format a native <input type="date"> will actually accept via fill(). */
function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Resolves a field to a computed value, or null if this field is not one of the questions
 * this module knows how to compute.
 *
 * `now` is injectable so a test does not have to be written on the one day of the year it
 * would otherwise flake.
 */
export function computedAnswerFor(
  field: Pick<DetectedField, "labelText" | "inputType">,
  now: Date = new Date(),
): ComputedAnswer | null {
  if (!isComputedQuestion(field.labelText)) return null;
  const value = field.inputType === "date" ? formatIsoDate(now) : formatUsDate(now);
  return { value, reason: "Computed today's date; never a stored fact to look up." };
}
