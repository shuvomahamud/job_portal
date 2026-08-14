/**
 * Whether the worker may follow a posting off the job board and apply on the employer's
 * own site.
 *
 * Applying on Indeed or Dice is a known, rehearsed flow. A company site is not: the form
 * is unseen, it may demand an account, and a submission cannot be taken back. So this is
 * deliberately a higher bar than an on-board apply rather than the same one.
 *
 * The score gate is the whole point. On-board applies are cheap to get wrong — a weak
 * match costs a form fill. Off-board applies cost an account with that employer and a real
 * submission under the candidate's name, so only strong matches are worth that.
 */

export type ExternalSiteDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export type ExternalSiteInput = {
  /** Hostname the apply button landed on, for the recorded reason. */
  host: string;
  /** Master switch; off means behave exactly as before and hand the job to the user. */
  enabled: boolean;
  /** Minimum match score, inclusive, for an off-board apply. */
  minScore: number;
  /** Null when the job was never scored against a role. */
  score: number | null;
  /**
   * The role-match verdict. A job can be rejected by the hard filter — an authorization
   * conflict, say — and still score highly, so the score alone is not enough. Real rows
   * in this database sit at 93 with a reject verdict.
   */
  status: string | null;
};

export function decideExternalSiteApply({
  host,
  enabled,
  minScore,
  score,
  status,
}: ExternalSiteInput): ExternalSiteDecision {
  if (!enabled) {
    return { allowed: false, reason: `External ATS host: ${host}` };
  }
  // Checked before the score so a rejected job reports why it was rejected rather than
  // implying it merely scored too low. A manual pick reaches here with the verdict intact,
  // which is the only place that gate is applied for one.
  if (status === "reject") {
    return {
      allowed: false,
      reason: `External site ${host} skipped: this job was rejected during matching.`,
    };
  }
  // An unscored job has not cleared the bar, it simply never faced it. A manual pick with
  // no score is included on purpose: choosing a job from the board authorises applying,
  // not applying somewhere unrehearsed with no idea how well it fits.
  if (score === null) {
    return {
      allowed: false,
      reason: `External site ${host} needs a match score of at least ${minScore}; this job was never scored.`,
    };
  }
  if (score < minScore) {
    return {
      allowed: false,
      reason: `External site ${host} needs a match score of at least ${minScore}; this job scored ${score}.`,
    };
  }
  return { allowed: true };
}
