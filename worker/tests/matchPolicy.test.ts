import assert from "node:assert/strict";
import test from "node:test";
import { findEvidenceContradictions } from "../src/ai/contradictions";
import { decideJobMatch } from "../src/ai/matchPolicy";
import type { JobMatchEvidence } from "../src/ai/matchSchema";

function evidence(overrides: Partial<JobMatchEvidence> = {}): JobMatchEvidence {
  return {
    schemaVersion: "job-match-v1",
    roleFit: "strong",
    skillFit: "strong",
    experienceFit: "strong",
    authorizationFit: "match",
    employmentFit: "match",
    locationFit: "match",
    confidence: "high",
    matchedEvidence: [{ criterion: "Stack", evidence: "The role explicitly requires C#, .NET, and SQL, all listed in the profile." }],
    gaps: [],
    hardBlockers: [],
    visaNotes: "The posting is compatible with the profile's stated authorization.",
    summary: "Strong technical and authorization match.",
    resumeAngle: "Emphasize C#, .NET, and SQL production experience.",
    ...overrides,
  };
}

test("deterministic policy promotes only a high-confidence compatible match", () => {
  const result = decideJobMatch(evidence());
  assert.equal(result.status, "ready_to_apply");
  assert.equal(result.recommendation, "match");
  assert.equal(result.score, 100);
});

test("unknown authorization is never automatically promoted", () => {
  const result = decideJobMatch(evidence({ authorizationFit: "unknown" }));
  assert.equal(result.status, "needs_review");
  assert.equal(result.recommendation, "uncertain");
});

test("supported sponsorship blocker is archived", () => {
  const result = decideJobMatch(
    evidence({
      authorizationFit: "conflict",
      hardBlockers: [{ type: "sponsorship", evidence: "The posting explicitly says visa sponsorship is unavailable." }],
    }),
  );
  assert.equal(result.status, "archived");
  assert.equal(result.visaSignal, "no_sponsorship");
});

test("an unavailable all-unknown review remains manual review instead of a rejection", () => {
  const result = decideJobMatch(
    evidence({
      roleFit: "unknown",
      skillFit: "unknown",
      experienceFit: "unknown",
      authorizationFit: "unknown",
      employmentFit: "unknown",
      locationFit: "unknown",
      confidence: "low",
      matchedEvidence: [],
      summary: "The local reviewer was unavailable.",
    }),
  );
  assert.equal(result.status, "needs_review");
});

test("contradictions are detected separately from model prose", () => {
  const contradictory = evidence({
    hardBlockers: [{ type: "authorization", evidence: "The posting and profile conflict on authorization." }],
  });
  const problems = findEvidenceContradictions(contradictory);
  assert.equal(problems.length, 1);
  assert.equal(decideJobMatch(contradictory).status, "needs_review");
});
