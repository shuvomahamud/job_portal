import assert from "node:assert/strict";
import test from "node:test";
import { describeApplyRunOutcome } from "../src/handlers/applyToJobs";

const summary = { submitted: 0, needsAnswers: 0, blocked: 0 };

test("a single job's real outcome is reported, not a batch label", () => {
  // The live bug: every command now carries exactly one job, and results.length reaching
  // runLimit is true for every ordinary completion of a one-element list — so a stall, a
  // failed upload, and a genuine submission were all reported as the same
  // "run_limit_reached", regardless of what actually happened.
  assert.equal(
    describeApplyRunOutcome([{ stopReason: "stalled" }], "eligible_jobs_exhausted", 1, summary),
    "Apply finished for 1 job: stalled.",
  );
  assert.equal(
    describeApplyRunOutcome([{ stopReason: "submitted" }], "eligible_jobs_exhausted", 1, summary),
    "Apply finished for 1 job: submitted.",
  );
  assert.equal(
    describeApplyRunOutcome([{ stopReason: "needs_manual" }], "eligible_jobs_exhausted", 1, summary),
    "Apply finished for 1 job: needs_manual.",
  );
});

test("a genuine multi-job batch still gets the summary form", () => {
  // Nothing sends more than one job today, but the payload schema still allows it, so the
  // batch-summary form is kept for that case rather than removed.
  const message = describeApplyRunOutcome(
    [{ stopReason: "submitted" }, { stopReason: "needs_manual" }],
    "run_limit_reached",
    2,
    { submitted: 1, needsAnswers: 0, blocked: 0 },
  );
  assert.match(message, /run_limit_reached/);
  assert.match(message, /2\/2 job/);
});
