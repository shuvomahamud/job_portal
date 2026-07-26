import assert from "node:assert/strict";
import test from "node:test";
import { commandPayloadSchemas } from "../../src/lib/validation";

test("find matching jobs accepts Indeed and Dice", () => {
  const parsed = commandPayloadSchemas.find_matching_jobs.parse({
    sources: ["indeed", "dice"],
    queries: [".NET Developer"],
    locations: ["Remote"],
    maxResults: 10,
  });
  assert.deepEqual(parsed.sources, ["indeed", "dice"]);
});

test("automated discovery rejects LinkedIn", () => {
  assert.equal(
    commandPayloadSchemas.find_matching_jobs.safeParse({
      sources: ["linkedin"],
      queries: [".NET Developer"],
      locations: ["Remote"],
      maxResults: 10,
    }).success,
    false,
  );
  assert.equal(
    commandPayloadSchemas.discover_jobs_browser.safeParse({
      sources: ["linkedin"],
      queries: [".NET Developer"],
    }).success,
    false,
  );
});

test("historical manual imports still allow LinkedIn source data", () => {
  assert.equal(
    commandPayloadSchemas.import_jobs.safeParse({
      source: "linkedin",
      urls: ["https://www.linkedin.com/jobs/view/123"],
    }).success,
    true,
  );
});
