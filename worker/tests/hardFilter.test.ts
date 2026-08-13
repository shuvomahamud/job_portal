import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProfileHardFilter } from "../src/ai/hardFilter";

const candidate = {
  targetTitles: [".NET Developer"],
  targetLocations: ["Remote"],
  skills: ["C#", ".NET", "SQL"],
  preferredEmploymentTypes: ["W2 contract"],
  workAuthorizationAnswer: "I am in H-1B status and can transfer.",
  sponsorshipAnswer: "I require H-1B transfer sponsorship.",
  salaryExpectation: null,
  summary: "Experienced C# and .NET engineer with SQL Server and production support experience.",
  dealBreakers: [],
  matchingInstructions: null,
      roleTitle: "",
      resumeText: "",
      resumeFacts: [],
};

const job = {
  id: "job-1",
  title: "Senior .NET Developer",
  company: "Acme",
  location: "Remote",
  source: "indeed",
  sourceUrl: "https://www.indeed.com/viewjob?jk=1",
  description: "C# .NET SQL Server role. ".repeat(40),
  salaryText: null,
  employmentType: "contract",
  remoteType: "remote",
  visaSignal: "unknown",
  techStack: ["C#", ".NET", "SQL"],
};

test("hard filter rejects no-sponsorship roles for sponsorship-dependent profiles", () => {
  const result = evaluateProfileHardFilter(candidate, { ...job, description: `${job.description} No visa sponsorship is available.` });
  assert.equal(result.eligible, false);
  if (!result.eligible) assert.equal(result.visaSignal, "no_sponsorship");
});

test("hard filter keeps no-sponsorship contract roles when the profile authorizes a vendor path", () => {
  const contractCandidate = {
    ...candidate,
    sponsorshipAnswer:
      "[authorized-contract-alternative] I need H-1B transfer for direct employment but may contract through an authorized employer/vendor.",
    matchingInstructions:
      "[authorized-contract-alternative] Keep contract roles for employer/vendor authorization review.",
  };
  const result = evaluateProfileHardFilter(contractCandidate, {
    ...job,
    employmentType: "contract",
    description: `${job.description} This is a W2 contract role. No visa sponsorship is available.`,
  });
  assert.deepEqual(result, { eligible: true });
});

test("contract alternative never bypasses a no-sponsorship permanent role", () => {
  const contractCandidate = {
    ...candidate,
    sponsorshipAnswer:
      "[authorized-contract-alternative] I need H-1B transfer for direct employment but may contract through an authorized employer/vendor.",
    matchingInstructions:
      "[authorized-contract-alternative] Keep contract roles for employer/vendor authorization review.",
  };
  const result = evaluateProfileHardFilter(contractCandidate, {
    ...job,
    employmentType: "full-time",
    description: `${job.description} Permanent full-time position. No visa sponsorship is available.`,
  });
  assert.equal(result.eligible, false);
  if (!result.eligible) assert.equal(result.visaSignal, "no_sponsorship");
});

test("hard filter rejects incomplete placeholder postings", () => {
  const result = evaluateProfileHardFilter(candidate, { ...job, title: ".NET Developer discovered job", description: "Open the source to verify details." });
  assert.equal(result.eligible, false);
  if (!result.eligible) assert.equal(result.visaSignal, "invalid_job");
});

test("valid compatible posting remains eligible for local AI", () => {
  const result = evaluateProfileHardFilter(candidate, job);
  assert.deepEqual(result, { eligible: true });
});
