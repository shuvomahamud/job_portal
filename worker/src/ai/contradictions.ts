import type { JobMatchEvidence } from "./matchSchema";

export function findEvidenceContradictions(evidence: JobMatchEvidence): string[] {
  const problems: string[] = [];
  const blockers = new Set(evidence.hardBlockers.map((blocker) => blocker.type));

  if (evidence.authorizationFit === "match" && (blockers.has("authorization") || blockers.has("sponsorship") || blockers.has("citizenship") || blockers.has("clearance"))) {
    problems.push("Authorization is marked as a match despite an authorization-related hard blocker.");
  }
  if (evidence.employmentFit === "match" && blockers.has("employment_type")) {
    problems.push("Employment is marked as a match despite an employment hard blocker.");
  }
  if (evidence.locationFit === "match" && blockers.has("location")) {
    problems.push("Location is marked as a match despite a location hard blocker.");
  }
  if (evidence.roleFit === "strong" && blockers.has("role")) {
    problems.push("Role is marked as strong despite a role hard blocker.");
  }
  if (evidence.experienceFit === "strong" && blockers.has("experience")) {
    problems.push("Experience is marked as strong despite an experience hard blocker.");
  }
  return problems;
}
