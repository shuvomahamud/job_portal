import assert from "node:assert/strict";
import test from "node:test";
import { validateCommandPayload } from "../../src/lib/validation";

test("new apply command payloads validate", () => {
  assert.deepEqual(
    validateCommandPayload("sync_resume_text", {}),
    {},
  );
  assert.deepEqual(
    validateCommandPayload("apply_to_jobs", {
      jobIds: ["33333333-3333-4333-8333-333333333333"],
      mode: "dry_run",
    }),
    {
      jobIds: ["33333333-3333-4333-8333-333333333333"],
      mode: "dry_run",
    },
  );
  assert.deepEqual(
    validateCommandPayload("run_apply_cycle", { phase: "discover", attempt: 0 }),
    { phase: "discover", attempt: 0 },
  );
  assert.deepEqual(
    validateCommandPayload("verify_submission", {
      applicationId: "44444444-4444-4444-8444-444444444444",
    }),
    { applicationId: "44444444-4444-4444-8444-444444444444" },
  );
});

test("apply command payloads reject forbidden execution keys", () => {
  assert.throws(
    () =>
      validateCommandPayload("apply_to_jobs", {
        jobIds: ["33333333-3333-4333-8333-333333333333"],
        command: "rm -rf /",
      }),
    /Execution field/,
  );
});
