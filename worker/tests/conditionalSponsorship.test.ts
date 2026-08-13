import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProfileHardFilter } from "../src/ai/hardFilter";
import { buildCandidateMatchingContext, buildJobMatchingContext } from "../src/ai/profileContext";

/**
 * The conditional H-1B policy: sponsorship is required for permanent roles, and contract
 * work is the exception. The exception is expressed as a scoped clause inside one free-text
 * answer, which the hard filter reads as a single string — so a clause meant only for
 * contract roles must not switch the whole filter off.
 */
const SPONSORSHIP =
  "[authorized-contract-alternative] I require H-1B sponsorship or transfer support for " +
  "permanent/direct-employment roles. I do not require sponsorship for contractor roles.";

const candidate = buildCandidateMatchingContext(
  {
    targetTitles: ["Senior .NET Developer"],
    targetLocations: ["New York, NY"],
    skills: ["C#", ".NET"],
    preferredEmploymentTypes: ["W2 contract"],
    workAuthorizationAnswer:
      "Yes. I am currently authorized to work in the United States in H-1B status.",
    sponsorshipAnswer: SPONSORSHIP,
    salaryExpectation: null,
    summary: "Senior C# and .NET engineer. ".repeat(10),
    dealBreakers: [],
    matchingInstructions: null,
  },
  { roleTitle: "Senior .NET Developer", locations: ["New York, NY"], resumeText: "x".repeat(300), resumeFacts: [] },
);

const job = (over: Record<string, unknown>) =>
  buildJobMatchingContext({
    id: "j",
    title: "Senior .NET Developer",
    company: "Acme",
    location: "New York, NY",
    source: "indeed",
    sourceUrl: "https://www.indeed.com/viewjob?jk=1",
    description: "Senior .NET engineering role. ".repeat(40),
    salaryText: null,
    employmentType: null,
    remoteType: null,
    visaSignal: "unknown",
    techStack: [],
    ...over,
  } as never);

test("a permanent role refusing sponsorship is rejected", () => {
  // Regression: the contract-scoped "do not require" clause used to clear the global
  // sponsorship need, so this posting passed the filter and got applied to.
  const result = evaluateProfileHardFilter(
    candidate,
    job({ description: "Full-time permanent role. No sponsorship available. " + "detail ".repeat(200) }),
  );
  assert.equal(result.eligible, false);
  assert.equal(result.eligible === false && result.visaSignal, "no_sponsorship");
});

test("a contract role refusing sponsorship still proceeds", () => {
  const result = evaluateProfileHardFilter(
    candidate,
    job({
      title: "Senior .NET Developer (W2 Contract)",
      employmentType: "contract",
      description: "W2 contract engagement. No sponsorship available. " + "detail ".repeat(200),
    }),
  );
  assert.equal(result.eligible, true);
});

test("citizenship-only and clearance roles stay blocked", () => {
  for (const description of [
    "US citizens only. " + "detail ".repeat(200),
    "Active security clearance required. " + "detail ".repeat(200),
  ]) {
    assert.equal(evaluateProfileHardFilter(candidate, job({ description })).eligible, false);
  }
});

test("an ordinary permanent role is unaffected", () => {
  assert.equal(evaluateProfileHardFilter(candidate, job({})).eligible, true);
});

test("a candidate who genuinely needs no sponsorship is still exempt", () => {
  // Without the marker, the plain "do not require" reading must still apply.
  const citizen = buildCandidateMatchingContext(
    {
      targetTitles: ["Senior .NET Developer"],
      targetLocations: ["New York, NY"],
      skills: ["C#"],
      preferredEmploymentTypes: [],
      workAuthorizationAnswer: "I am a U.S. permanent resident.",
      sponsorshipAnswer: "I do not require sponsorship.",
      salaryExpectation: null,
      summary: "Senior engineer. ".repeat(10),
      dealBreakers: [],
      matchingInstructions: null,
    },
    { roleTitle: "Senior .NET Developer", locations: ["New York, NY"], resumeText: "x".repeat(300), resumeFacts: [] },
  );
  const result = evaluateProfileHardFilter(
    citizen,
    job({ description: "Permanent role. No sponsorship available. " + "detail ".repeat(200) }),
  );
  assert.equal(result.eligible, true);
});
