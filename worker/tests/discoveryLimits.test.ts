import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DISCOVERY_RESULTS_PER_COMMAND,
  discoveryTargetFor,
} from "../src/search/discoveryLimits";
import { payloadSchema as findMatchingJobsSchema } from "../src/handlers/findMatchingJobs";
import { payloadSchema as discoverJobsBrowserSchema } from "../src/handlers/discoverJobsBrowser";

/** The largest run the dashboard and the run_apply_cycle payload schema allow. */
const MAX_APPLY_JOBS_PER_RUN = 50;

test("every run size the dashboard offers produces an acceptable discovery target", () => {
  // The regression this guards: asking for 50 applications computed a target of 100,
  // find_matching_jobs capped maxResults at 50, and the command failed validation
  // before searching anything. The board stayed empty with no visible error.
  for (let requested = 1; requested <= MAX_APPLY_JOBS_PER_RUN; requested += 1) {
    const target = discoveryTargetFor(requested);
    assert.ok(
      target <= MAX_DISCOVERY_RESULTS_PER_COMMAND,
      `asking for ${requested} jobs wants ${target} postings, over the ${MAX_DISCOVERY_RESULTS_PER_COMMAND} cap`,
    );
    assert.ok(target >= 1, `asking for ${requested} jobs must search for at least one posting`);
  }
});

test("discovery out-runs the apply target so uncertain and rejected postings do not starve it", () => {
  assert.equal(discoveryTargetFor(20), 40);
  assert.equal(discoveryTargetFor(25), 50);
});

test("a small run still searches a useful number of postings", () => {
  assert.equal(discoveryTargetFor(1), 10);
  assert.equal(discoveryTargetFor(4), 10);
});

test("a large run is capped rather than rejected", () => {
  assert.equal(discoveryTargetFor(50), MAX_DISCOVERY_RESULTS_PER_COMMAND);
  assert.equal(discoveryTargetFor(500), MAX_DISCOVERY_RESULTS_PER_COMMAND);
});

test("both discovery handlers accept every target the cycle can produce", () => {
  // The real schemas, not copies: the outage was one handler holding its own literal cap
  // while the layer above it computed a larger number.
  for (const requested of [1, 10, 20, 25, 26, 49, 50]) {
    const maxResults = discoveryTargetFor(requested);
    const found = findMatchingJobsSchema.parse({
      queries: ["Senior .NET Full-Stack Engineer"],
      locations: ["Remote (United States)"],
      maxResults,
    });
    assert.equal(found.maxResults, maxResults);

    // find_matching_jobs forwards maxResults untouched, so the inner handler must agree.
    const browser = discoverJobsBrowserSchema.parse({
      queries: ["Senior .NET Full-Stack Engineer"],
      locations: ["Remote (United States)"],
      maxResults,
    });
    assert.equal(browser.maxResults, maxResults);
  }
});
