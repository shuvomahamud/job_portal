import assert from "node:assert/strict";
import test from "node:test";
import {
  abortWorker,
  applyShouldHalt,
  isWorkerAborted,
  resetWorkerAbortForTests,
} from "../src/workerAbort";

test("abortWorker is visible immediately, before any dashboard round-trip", async (t) => {
  t.after(resetWorkerAbortForTests);
  assert.equal(isWorkerAborted(), false);
  abortWorker();
  assert.equal(isWorkerAborted(), true);
  // Must not consult command status once the local flag is set — that read is what
  // raced with the submit click during the four-second abandon report.
  assert.equal(await applyShouldHalt("not-a-real-command"), true);
});
