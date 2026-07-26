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
    <a href="/viewjob?jk=12345&utm_source=test">Indeed job</a>
    <a href="https://www.indeed.com/jobs?q=.net">Search page</a>
    <a href="https://example.com/jobs/view/999">Other host</a>
  `;
  assert.deepEqual(extractJobUrlsFromHtml("indeed", html, "https://www.indeed.com/jobs?q=.net", 10), [
    "https://www.indeed.com/viewjob?jk=12345",
  ]);
});

test("normalizeJobUrl supports Indeed and Dice job patterns", () => {
  assert.equal(
    normalizeJobUrl("indeed", "/viewjob?jk=abc123&utm_source=x", "https://www.indeed.com/jobs?q=.net"),
    "https://www.indeed.com/viewjob?jk=abc123",
  );
  assert.equal(
    normalizeJobUrl(
      "indeed",
      "/rc/clk?jk=abc123&amp;cmp=Acme+Corp&amp;ti=.NET+Developer&amp;vjk=tracking",
      "https://www.indeed.com/jobs?q=.net",
    ),
    "https://www.indeed.com/rc/clk?jk=abc123&cmp=Acme+Corp&ti=.NET+Developer",
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
  const [job] = buildDiscoveredJobRecords("indeed", ["https://www.indeed.com/viewjob?jk=123"], {
    query: ".NET C# SQL",
    location: "Remote",
  });
  assert.equal(job.source, "indeed");
  assert.equal(job.status, "new");
  assert.deepEqual(job.techStack, [".NET", "C#", "SQL"]);
  assert.match(job.notes ?? "", /no apply\/submit automation/i);
});

test("buildDiscoveredJobRecords uses Indeed URL metadata when available", () => {
  const [job] = buildDiscoveredJobRecords(
    "indeed",
    ["https://www.indeed.com/rc/clk?jk=abc123&cmp=Acme+Corp&ti=Senior+.NET+Developer"],
    { query: ".NET Application Support", location: "Remote" },
  );

  assert.equal(job.title, "Senior .NET Developer");
  assert.equal(job.company, "Acme Corp");
  assert.equal(job.sourceUrl, "https://www.indeed.com/rc/clk?jk=abc123&cmp=Acme+Corp&ti=Senior+.NET+Developer");
});
