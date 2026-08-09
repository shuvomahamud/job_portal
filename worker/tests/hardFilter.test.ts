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

test("hard filter rejects incomplete placeholder postings", () => {
  const result = evaluateProfileHardFilter(candidate, { ...job, title: ".NET Developer discovered job", description: "Open the source to verify details." });
  assert.equal(result.eligible, false);
  if (!result.eligible) assert.equal(result.visaSignal, "invalid_job");
});

test("valid compatible posting remains eligible for local AI", () => {
  const result = evaluateProfileHardFilter(candidate, job);
  assert.deepEqual(result, { eligible: true });
});
