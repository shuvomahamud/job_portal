import assert from "node:assert/strict";
import test from "node:test";
import { decideExternalSiteApply } from "../src/apply/externalSitePolicy";

const base = { host: "careers.acme.com", enabled: true, minScore: 80 };

test("a strong match on an employer site is allowed", () => {
  const decision = decideExternalSiteApply({ ...base, score: 92, status: "match" });
  assert.equal(decision.allowed, true);
});

test("exactly the threshold is allowed", () => {
  assert.equal(
    decideExternalSiteApply({ ...base, score: 80, status: "match" }).allowed,
    true,
  );
});

test("a weak match is held for the user", () => {
  const decision = decideExternalSiteApply({ ...base, score: 79, status: "match" });
  assert.equal(decision.allowed, false);
  assert.match(decision.allowed ? "" : decision.reason, /at least 80.*scored 79/);
});

test("a rejected job never reaches an employer site, however well it scored", () => {
  // Two rows in the real database sit at 80+ with a reject verdict — hard-filtered on
  // something like an authorization conflict while still scoring well. Gating on score
  // alone would send exactly those to a company's own careers page.
  const decision = decideExternalSiteApply({ ...base, score: 93, status: "reject" });
  assert.equal(decision.allowed, false);
  assert.match(decision.allowed ? "" : decision.reason, /rejected during matching/);
});

test("an unscored job has not cleared the bar, it never faced it", () => {
  const decision = decideExternalSiteApply({ ...base, score: null, status: null });
  assert.equal(decision.allowed, false);
  assert.match(decision.allowed ? "" : decision.reason, /never scored/);
});

test("with the feature off, nothing changes for the user", () => {
  // The old wording, so an existing needs-manual row still reads the way it always did.
  const decision = decideExternalSiteApply({
    ...base,
    enabled: false,
    score: 99,
    status: "match",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed ? "" : decision.reason, "External ATS host: careers.acme.com");
});

test("an uncertain job passes on score alone", () => {
  // Only a rejection is disqualifying. An uncertain job cannot reach here automatically —
  // the cycle selects only "match" — so in practice this is a job the user picked by hand,
  // and the score is what governs.
  const decision = decideExternalSiteApply({ ...base, score: 85, status: "uncertain" });
  assert.equal(decision.allowed, true);
});
