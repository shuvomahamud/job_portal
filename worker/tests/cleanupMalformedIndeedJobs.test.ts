import assert from "node:assert/strict";
import test from "node:test";
import { isRecoverableStuckApplication } from "../scripts/cleanupMalformedIndeedJobs";

const base = {
  id: "app-1",
  status: "filling",
  jobId: "job-1",
  workerCommandId: "cmd-1",
  commandStatus: "claimed" as string | null,
  heartbeatAt: new Date("2026-08-15T04:00:00.000Z"),
  claimedAt: new Date("2026-08-15T03:50:00.000Z"),
};

test("cleanup does not recover a live claimed application with a fresh heartbeat", () => {
  const now = Date.parse("2026-08-15T04:02:00.000Z");
  assert.equal(isRecoverableStuckApplication(base, now), false);
});

test("cleanup recovers applications whose command already failed or was canceled", () => {
  const now = Date.parse("2026-08-15T04:02:00.000Z");
  assert.equal(isRecoverableStuckApplication({ ...base, commandStatus: "failed" }, now), true);
  assert.equal(isRecoverableStuckApplication({ ...base, commandStatus: "canceled" }, now), true);
  assert.equal(isRecoverableStuckApplication({ ...base, commandStatus: "completed" }, now), true);
});

test("cleanup recovers a claimed application only after the stale-claim window", () => {
  const now = Date.parse("2026-08-15T04:09:00.000Z");
  assert.equal(isRecoverableStuckApplication(base, now), true);
});
