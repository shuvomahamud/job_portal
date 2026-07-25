import test from "node:test";
import assert from "node:assert/strict";
import { evaluateJob } from "../src/rules/ruleEngine";

test("evaluateJob scores target .NET support jobs highly", () => {
  const result = evaluateJob({
    title: ".NET Application Support Developer",
    company: "Example Co",
    location: "Remote",
    source: "other",
    sourceUrl: "https://example.com/job/1",
    description: "C# ASP.NET SQL Server Oracle production support Azure REST API contract role. Remote.",
  });

  assert.equal(result.recommendation, "apply");
  assert.equal(result.status, "ready_to_apply");
  assert.ok(result.score >= 72);
  assert.ok(result.techStack.includes(".NET"));
  assert.ok(result.techStack.includes("C#"));
  assert.ok(result.techStack.includes("SQL"));
});

test("evaluateJob downgrades citizen-only clearance jobs", () => {
  const result = evaluateJob({
    title: "Java Developer",
    company: "Defense Co",
    location: "Onsite",
    source: "other",
    sourceUrl: "https://example.com/job/2",
    description: "Java Spring Boot role. U.S. citizens only. Active secret security clearance required.",
  });

  assert.equal(result.recommendation, "skip");
  assert.equal(result.status, "archived");
  assert.equal(result.visaSignal, "citizen_only");
  assert.ok(result.score < 50);
});
