import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeHtmlAttribute,
  extractIndeedMetadata,
  extractJobDetail,
  extractJsonLdJobPosting,
  stripHtmlToText,
} from "../src/search/jobDetailExtraction";

test("decodeHtmlAttribute decodes common URL entities", () => {
  assert.equal(decodeHtmlAttribute("/rc/clk?jk=abc&amp;cmp=Acme&amp;ti=.NET+Developer"), "/rc/clk?jk=abc&cmp=Acme&ti=.NET+Developer");
});

test("extractIndeedMetadata reads title and company from encoded Indeed URLs", () => {
  const metadata = extractIndeedMetadata("https://www.indeed.com/rc/clk?jk=abc123&amp;cmp=Acme+Corp&amp;ti=Senior+.NET+Developer&amp;vjk=tracking");
  assert.equal(metadata.title, "Senior .NET Developer");
  assert.equal(metadata.company, "Acme Corp");
  assert.equal(metadata.sourceUrl, "https://www.indeed.com/rc/clk?jk=abc123&cmp=Acme+Corp&ti=Senior+.NET+Developer&vjk=tracking");
});

test("extractJsonLdJobPosting reads JobPosting fields", () => {
  const html = `
    <html><head><script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": "Application Support .NET Developer",
        "description": "Support ASP.NET, C#, SQL and Oracle applications. W2 contract.",
        "employmentType": "CONTRACTOR",
        "hiringOrganization": { "name": "Acme Staffing" },
        "jobLocation": { "address": { "addressLocality": "Albany", "addressRegion": "NY", "addressCountry": "US" } },
        "datePosted": "2026-07-20"
      }
    </script></head></html>`;

  const detail = extractJsonLdJobPosting(html);
  assert.equal(detail.title, "Application Support .NET Developer");
  assert.equal(detail.company, "Acme Staffing");
  assert.equal(detail.employmentType, "contract");
  assert.equal(detail.location, "Albany, NY, US");
  assert.match(detail.description ?? "", /Oracle applications/);
  assert.ok(detail.postedDate instanceof Date);
});

test("stripHtmlToText removes scripts and keeps readable text", () => {
  assert.equal(stripHtmlToText("<div>Hello&nbsp;<b>world</b></div><script>bad()</script>"), "Hello world");
});

test("extractJobDetail merges URL metadata, JSON-LD, text signals, and fallback safely", () => {
  const html = `
    <html><head><title>Senior .NET Developer - Digital Dhara | Indeed</title></head>
    <body>
      <h1>Senior .NET Developer</h1>
      <div id="jobDescriptionText">
        We need C#, ASP.NET, SQL Server and application support experience.
        This is a W2 contract role through a staffing vendor. H-1B transfer considered.
      </div>
    </body></html>`;
  const detail = extractJobDetail(
    "indeed",
    "https://www.indeed.com/rc/clk?jk=abc123&amp;cmp=Digital+Dhara&amp;ti=Senior+.NET+Developer",
    html,
    { query: ".NET Application Support", location: "Remote" },
  );

  assert.equal(detail.title, "Senior .NET Developer");
  assert.equal(detail.company, "Digital Dhara");
  assert.equal(detail.sourceUrl, "https://www.indeed.com/rc/clk?jk=abc123&cmp=Digital+Dhara&ti=Senior+.NET+Developer");
  assert.equal(detail.employmentType, "w2-contract");
  assert.equal(detail.visaSignal, "h1b_transfer_explicit");
  assert.deepEqual(detail.techStack, [".NET", "C#", "SQL", "Production Support"]);
});

test("extractJobDetail falls back without throwing", () => {
  const detail = extractJobDetail("indeed", "not a url", "<html></html>", { query: ".NET Developer", location: "Remote" });
  assert.equal(detail.title, ".NET Developer discovered job — Remote");
  assert.equal(detail.company, "indeed browser discovery");
  assert.equal(detail.sourceUrl, "not a url");
});

test("extractJobDetail lets negative sponsorship wording win", () => {
  const detail = extractJobDetail(
    "indeed",
    "https://www.indeed.com/viewjob?jk=no-sponsor",
    "<html><body><h1>.NET Developer</h1><div>No visa sponsorship is available for this W2 contract role.</div></body></html>",
    { query: ".NET Developer", location: "Remote" },
  );
  assert.equal(detail.visaSignal, "no_sponsorship");
});
