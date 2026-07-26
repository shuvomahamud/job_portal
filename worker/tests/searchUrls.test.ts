import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchLinkJobs } from "../src/search/searchUrls";

test("buildSearchLinkJobs creates conservative search-link records", () => {
  const jobs = buildSearchLinkJobs([
    { source: "indeed", query: ".NET C# SQL", location: "Remote" },
    { source: "indeed", query: "application support Oracle", location: "Albany NY" },
  ], 10);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].source, "indeed");
  assert.match(jobs[0].sourceUrl, /indeed\.com\/jobs/);
  assert.deepEqual(jobs[0].techStack, [".NET", "C#", "SQL"]);
});

test("buildSearchLinkJobs dedupes and respects limit", () => {
  const specs = [
    { source: "dice" as const, query: ".NET", location: "Remote" },
    { source: "dice" as const, query: ".NET", location: "Remote" },
    { source: "indeed" as const, query: ".NET", location: "Remote" },
  ];
  const jobs = buildSearchLinkJobs(specs, 1);
  assert.equal(jobs.length, 1);
});
