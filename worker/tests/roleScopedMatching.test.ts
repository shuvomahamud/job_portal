import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidateMatchingContext, fingerprintCandidate } from "../src/ai/profileContext";
import { chooseBestEligibleRoleMatch } from "../src/db";

const baseProfile = {
  targetTitles: ["Software Engineer"],
  targetLocations: ["Remote"],
  skills: ["C#", ".NET"],
  preferredEmploymentTypes: ["contract"],
  workAuthorizationAnswer: "Authorized to work in the US",
  sponsorshipAnswer: "Requires sponsorship",
  salaryExpectation: null,
  summary: "Experienced .NET engineer building reliable backends and workflow systems for product teams.",
  dealBreakers: [],
  matchingInstructions: null,
};

test("role-scoped matching context uses role title and resume text", () => {
  const context = buildCandidateMatchingContext(baseProfile, {
    roleTitle: "Senior .NET Developer",
    locations: ["New York"],
    resumeText: "C# SQL Server Oracle Azure ".repeat(40),
  });
  assert.deepEqual(context.targetTitles, ["Senior .NET Developer"]);
  assert.deepEqual(context.targetLocations, ["New York"]);
  assert.equal(context.roleTitle, "Senior .NET Developer");
  assert.ok(context.resumeText.length > 100);
});

test("resume text changes the candidate fingerprint", () => {
  const withoutResume = fingerprintCandidate(buildCandidateMatchingContext(baseProfile));
  const withResume = fingerprintCandidate(
    buildCandidateMatchingContext(baseProfile, {
      roleTitle: "Senior .NET Developer",
      resumeText: "Distinct resume body for fingerprinting.",
    }),
  );
  assert.notEqual(withoutResume, withResume);
});

test("highest-scoring eligible role deterministically supplies the resume", () => {
  const best = chooseBestEligibleRoleMatch([
    {
      id: "b-match",
      jobId: "job-1",
      targetRoleId: "role-b",
      resumeVersionId: "resume-b",
      status: "match",
      score: 82,
    },
    {
      id: "a-match",
      jobId: "job-1",
      targetRoleId: "role-a",
      resumeVersionId: "resume-a",
      status: "match",
      score: 91,
    },
    {
      id: "rejected",
      jobId: "job-1",
      targetRoleId: "role-c",
      resumeVersionId: "resume-c",
      status: "reject",
      score: 99,
    },
  ]);

  assert.equal(best?.targetRoleId, "role-a");
  assert.equal(best?.resumeVersionId, "resume-a");
  assert.equal(best?.score, 91);
});
