import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBrowserSearchUrl,
  buildDiscoveredJobRecords,
  extractJobUrlsFromHtml,
  humanDelayMs,
  normalizeJobUrl,
} from "../src/search/browserDiscovery";

test("buildBrowserSearchUrl creates source-specific search pages", () => {
  assert.equal(
    buildBrowserSearchUrl({ source: "linkedin", query: ".NET C# SQL", location: "Remote" }),
    "https://www.linkedin.com/jobs/search/?keywords=.NET%20C%23%20SQL&location=Remote",
  );
  assert.equal(
    buildBrowserSearchUrl({ source: "indeed", query: "application support", location: "Albany NY" }),
    "https://www.indeed.com/jobs?q=application%20support&l=Albany%20NY",
  );
  assert.equal(
    buildBrowserSearchUrl({ source: "dice", query: "Oracle SQL" }),
    "https://www.dice.com/jobs?q=Oracle%20SQL",
  );
});

test("extractJobUrlsFromHtml keeps only matching individual job urls", () => {
  const html = `
    <a href="/jobs/view/12345/?trk=public_jobs">LinkedIn job</a>
    <a href="https://www.linkedin.com/jobs/search/?keywords=.net">Search page</a>
    <a href="https://example.com/jobs/view/999">Other host</a>
  `;
  assert.deepEqual(extractJobUrlsFromHtml("linkedin", html, "https://www.linkedin.com/jobs/search/", 10), [
    "https://www.linkedin.com/jobs/view/12345/",
  ]);
});

test("normalizeJobUrl supports Indeed and Dice job patterns", () => {
  assert.equal(
    normalizeJobUrl("indeed", "/viewjob?jk=abc123&utm_source=x", "https://www.indeed.com/jobs?q=.net"),
    "https://www.indeed.com/viewjob?jk=abc123",
  );
  assert.equal(
    normalizeJobUrl("dice", "https://www.dice.com/job-detail/abc?utm_campaign=x", "https://www.dice.com/jobs"),
    "https://www.dice.com/job-detail/abc",
  );
});

test("humanDelayMs respects human-speed bounds", () => {
  assert.equal(humanDelayMs({ minDelayMs: 15000, maxDelayMs: 45000 }, () => 0), 15000);
  assert.equal(humanDelayMs({ minDelayMs: 15000, maxDelayMs: 45000 }, () => 1), 45000);
});

test("buildDiscoveredJobRecords marks browser discovery jobs safely", () => {
  const [job] = buildDiscoveredJobRecords("linkedin", ["https://www.linkedin.com/jobs/view/123"], {
    query: ".NET C# SQL",
    location: "Remote",
  });
  assert.equal(job.source, "linkedin");
  assert.equal(job.status, "new");
  assert.deepEqual(job.techStack, [".NET", "C#", "SQL"]);
  assert.match(job.notes ?? "", /no apply\/submit automation/i);
});
