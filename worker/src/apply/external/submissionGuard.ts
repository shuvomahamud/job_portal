/**
 * The last check before an irreversible click.
 *
 * On an employer's own site nothing about the page is rehearsed, and a model may have
 * helped decide which control to press. That is acceptable for finding a button and not
 * acceptable for deciding to press it: a submission cannot be withdrawn, and it goes out
 * under the candidate's real name.
 *
 * So the model proposes and this decides. Every reason to refuse is enumerated here rather
 * than scattered through the executor, because a gap in this function is the one kind of
 * bug that cannot be corrected afterwards.
 */

export type SubmissionContext = {
  /** Fill-only and dry-run runs never submit, whatever the page looks like. */
  mode: "dry_run" | "fill_only" | "fill_and_submit";
  /** Required fields the detector could not fill and had to ask the user about. */
  unansweredRequiredFields: number;
  /** Open questions already raised for this application. */
  openQuestions: number;
  /** A blocker was detected on this page. */
  blocked: boolean;
  /** The control was located by a model rather than a deterministic selector. */
  proposedByModel: boolean;
  /** Whether the located control actually looks like a terminal submit. */
  looksTerminal: boolean;
  /** The resume was attached and the page shows it. */
  resumeAttached: boolean;
  /** Match score for the posting, null when never scored. */
  score: number | null;
  /** Minimum score an off-board application requires. */
  minScore: number;
};

export type SubmissionDecision =
  | { submit: true }
  | { submit: false; reason: string };

export function decideSubmission(context: SubmissionContext): SubmissionDecision {
  if (context.mode !== "fill_and_submit") {
    return { submit: false, reason: `Mode is ${context.mode}; the form was filled but not submitted.` };
  }
  if (context.blocked) {
    return { submit: false, reason: "A challenge is on the page; nothing is submitted while blocked." };
  }
  if (!context.looksTerminal) {
    return { submit: false, reason: "The located control does not look like a final submit." };
  }
  if (context.unansweredRequiredFields > 0) {
    return {
      submit: false,
      reason: `${context.unansweredRequiredFields} required field(s) are still unanswered.`,
    };
  }
  if (context.openQuestions > 0) {
    return {
      submit: false,
      reason: `${context.openQuestions} question(s) are waiting on you.`,
    };
  }
  // Submitting without the resume attached is worse than not applying: it spends the
  // opportunity and puts an incomplete application in front of the employer.
  if (!context.resumeAttached) {
    return { submit: false, reason: "The resume is not attached to this application." };
  }
  // Re-checked here rather than trusted from the earlier gate. Between that check and this
  // click the agent has navigated an unfamiliar site for several minutes, and this is the
  // last point at which being wrong is still recoverable.
  if (context.score === null) {
    return { submit: false, reason: "This posting was never scored." };
  }
  if (context.score < context.minScore) {
    return {
      submit: false,
      reason: `Scored ${context.score}, below the ${context.minScore} an employer-site application requires.`,
    };
  }
  return { submit: true };
}
