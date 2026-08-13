import type { Priority } from "../types";
import { findEvidenceContradictions } from "./contradictions";
import type { JobMatchEvidence } from "./matchSchema";

export type JobMatchRecommendation = "match" | "uncertain" | "reject";

export type JobMatchDecision = {
  recommendation: JobMatchRecommendation;
  status: "ready_to_apply" | "needs_review" | "archived";
  score: number;
  priority: Priority;
  visaSignal: string;
  reasons: string[];
  contradictions: string[];
};

const fitPoints = {
  roleFit: { strong: 25, partial: 15, unknown: 8, weak: 0 },
  skillFit: { strong: 30, partial: 18, unknown: 10, weak: 0 },
  experienceFit: { strong: 15, partial: 9, unknown: 5, weak: 0 },
} as const;

const compatibilityPoints = { match: 1, unknown: 0, conflict: 0 } as const;

function priorityFor(score: number, status: JobMatchDecision["status"]): Priority {
  if (status === "archived") return "low";
  if (status === "needs_review") return "normal";
  if (score >= 90) return "urgent";
  if (score >= 80) return "high";
  return "normal";
}

function visaSignalFor(evidence: JobMatchEvidence) {
  const types = evidence.hardBlockers.map((blocker) => blocker.type);
  if (types.includes("citizenship")) return "citizen_only";
  if (types.includes("clearance")) return "clearance_required";
  if (types.includes("sponsorship")) return "no_sponsorship";
  if (evidence.authorizationFit === "match") return "profile_compatible";
  if (evidence.authorizationFit === "conflict") return "authorization_conflict";
  return "unknown";
}

export function decideJobMatch(evidence: JobMatchEvidence): JobMatchDecision {
  const contradictions = findEvidenceContradictions(evidence);
  const score = Math.max(
    0,
    Math.min(
      100,
      fitPoints.roleFit[evidence.roleFit] +
        fitPoints.skillFit[evidence.skillFit] +
        fitPoints.experienceFit[evidence.experienceFit] +
        compatibilityPoints[evidence.authorizationFit] * 15 +
        compatibilityPoints[evidence.employmentFit] * 8 +
        compatibilityPoints[evidence.locationFit] * 7,
    ),
  );
  const reasons = [...evidence.hardBlockers.map((blocker) => blocker.evidence), ...contradictions];
  const conflicts = [evidence.authorizationFit, evidence.employmentFit, evidence.locationFit].includes("conflict");
  const criticalUnknown = [evidence.authorizationFit, evidence.employmentFit, evidence.locationFit].includes("unknown");
  const weakCoreFit = evidence.roleFit === "weak" && evidence.skillFit === "weak";
  const hardReject = Boolean(evidence.hardBlockers.length || conflicts || weakCoreFit);

  if (contradictions.length) {
    return {
      recommendation: "uncertain",
      status: "needs_review",
      score,
      priority: priorityFor(score, "needs_review"),
      visaSignal: visaSignalFor(evidence),
      reasons: contradictions,
      contradictions,
    };
  }

  const allCoreFitUnknown = evidence.roleFit === "unknown" && evidence.skillFit === "unknown" && evidence.experienceFit === "unknown";
  if (hardReject || (score < 55 && !allCoreFitUnknown)) {
    return {
      recommendation: "reject",
      status: "archived",
      score,
      priority: priorityFor(score, "archived"),
      visaSignal: visaSignalFor(evidence),
      reasons: reasons.length ? reasons : ["Insufficient role and skills alignment for the configured profile."],
      contradictions,
    };
  }

  const canMatch =
    score >= 75 &&
    // Silence about sponsorship is the norm, not a warning sign: a posting scores
    // authorizationFit "match" only when it explicitly permits the candidate's situation,
    // which almost none do. Requiring that made "match" nearly unreachable for an H-1B
    // profile, so nothing was ever auto-applied to. "conflict" is still refused, and a
    // posting that explicitly rules the candidate out was already rejected above by
    // hardReject and by the hard filter before it ever reached scoring.
    evidence.authorizationFit !== "conflict" &&
    evidence.employmentFit !== "conflict" &&
    evidence.locationFit !== "conflict" &&
    evidence.roleFit !== "weak" &&
    evidence.skillFit !== "weak" &&
    evidence.confidence !== "low" &&
    contradictions.length === 0;

  if (canMatch) {
    return {
      recommendation: "match",
      status: "ready_to_apply",
      score,
      priority: priorityFor(score, "ready_to_apply"),
      visaSignal: visaSignalFor(evidence),
      reasons: reasons.length ? reasons : evidence.matchedEvidence.map((item) => item.evidence).slice(0, 3),
      contradictions,
    };
  }

  const uncertainReasons = [
    ...reasons,
    ...(criticalUnknown ? ["A critical job requirement is missing or ambiguous."] : []),
    ...(evidence.confidence === "low" ? ["The model reported low confidence."] : []),
    ...(score >= 55 && score < 75 ? ["The match score is in the manual-review range."] : []),
  ];
  return {
    recommendation: "uncertain",
    status: "needs_review",
    score,
    priority: priorityFor(score, "needs_review"),
    visaSignal: visaSignalFor(evidence),
    reasons: Array.from(new Set(uncertainReasons)).slice(0, 8),
    contradictions,
  };
}
