import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireWorkerProcessLock } from "../src/processLock";

test("allows only one local worker process for a worker id", (t) => {
  const root = mkdtempSync(join(tmpdir(), "job-worker-lock-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = acquireWorkerProcessLock("job-worker-test", root);
  assert.throws(
    () => acquireWorkerProcessLock("job-worker-test", root),
    /already running.*refusing to start a duplicate/i,
  );

  first.release();
  const replacement = acquireWorkerProcessLock("job-worker-test", root);
  replacement.release();
});
