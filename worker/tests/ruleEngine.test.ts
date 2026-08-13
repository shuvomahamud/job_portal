import test from "node:test";
import assert from "node:assert/strict";
import { evaluateJob } from "../src/rules/ruleEngine";

test("evaluateJob scores target .NET support contract jobs highly", () => {
  const result = evaluateJob({
    title: ".NET Application Support Developer",
    company: "Example Staffing",
    location: "Remote",
    source: "other",
    sourceUrl: "https://example.com/job/1",
    description: "C# ASP.NET SQL Server Oracle production support Azure REST API W2 contract role through staffing vendor. Remote.",
  });

  assert.equal(result.recommendation, "apply");
  assert.equal(result.status, "ready_to_apply");
  assert.ok(result.score >= 72);
  assert.equal(result.visaSignal, "contract_vendor_likely");
  assert.ok(result.techStack.includes(".NET"));
  assert.ok(result.techStack.includes("C#"));
  assert.ok(result.techStack.includes("SQL"));
});

test("evaluateJob sends full-time .NET jobs with unknown sponsorship to manual review", () => {
  const result = evaluateJob({
    title: "Senior .NET Developer",
    company: "Product Co",
    location: "Remote",
    source: "other",
    sourceUrl: "https://example.com/job/full-time",
    description: "Full-time role building ASP.NET C# Web API services with SQL Server and Azure. Remote.",
  });

  assert.equal(result.recommendation, "maybe");
  assert.equal(result.status, "needs_review");
  assert.equal(result.visaSignal, "unknown");
  assert.match(result.visaNotes, /No clear visa/i);
  assert.ok(result.gaps.some((gap) => /Full-time role with unknown sponsorship/i.test(gap)));
});

test("evaluateJob skips no-sponsorship jobs even when stack matches", () => {
  const result = evaluateJob({
    title: ".NET Application Support Developer",
    company: "Enterprise Co",
    location: "Remote",
    source: "other",
    sourceUrl: "https://example.com/job/no-sponsor",
    description: "C# ASP.NET SQL production support. We are unable to sponsor or transfer visas now or in the future.",
  });

  assert.equal(result.recommendation, "skip");
  assert.equal(result.status, "archived");
  assert.equal(result.visaSignal, "no_sponsorship");
});

test("evaluateJob accepts a matching W2 contract without sponsorship", () => {
  const result = evaluateJob({
    title: ".NET Application Support Developer",
    company: "Enterprise Co",
    location: "Remote",
    source: "other",
    sourceUrl: "https://example.com/job/no-visa-sponsor",
    description: "Remote W2 contract role for C# ASP.NET SQL application support. No visa sponsorship is available.",
  });

  assert.equal(result.recommendation, "apply");
  assert.equal(result.status, "ready_to_apply");
  assert.equal(result.visaSignal, "contract_no_sponsorship");
});

test("evaluateJob accepts another matching no-sponsorship contract role", () => {
  const result = evaluateJob({
    title: "Senior .NET Developer",
    company: "Example Staffing",
    location: "Remote",
    source: "other",
    sourceUrl: "https://example.com/job/contract-no-sponsor",
    employmentType: "contract",
    description: "C# ASP.NET SQL Server Azure role. W2 contract through a staffing vendor. No visa sponsorship is available.",
  });
  assert.equal(result.visaSignal, "contract_no_sponsorship");
  assert.equal(result.recommendation, "apply");
  assert.equal(result.status, "ready_to_apply");
});

test("evaluateJob skips citizen-only clearance jobs", () => {
  const result = evaluateJob({
    title: ".NET Developer",
    company: "Defense Co",
    location: "Onsite",
    source: "other",
    sourceUrl: "https://example.com/job/2",
    description: "C# ASP.NET role. U.S. citizens only. Active secret security clearance required.",
  });

  assert.equal(result.recommendation, "skip");
  assert.equal(result.status, "archived");
  assert.equal(result.visaSignal, "citizen_only");
  assert.ok(result.score < 50);
});

test("evaluateJob skips Java-only contract jobs despite contract signal", () => {
  const result = evaluateJob({
    title: "Java Developer",
    company: "Staffing Vendor",
    location: "Remote",
    source: "other",
    sourceUrl: "https://example.com/job/java",
    description: "Remote W2 contract role for Java Spring Boot microservices. Staffing vendor role.",
  });

  assert.equal(result.recommendation, "skip");
  assert.equal(result.status, "archived");
  assert.ok(result.score < 72);
});
