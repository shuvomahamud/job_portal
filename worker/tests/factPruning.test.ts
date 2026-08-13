import assert from "node:assert/strict";
import test from "node:test";
import { upsertCandidateFacts } from "../src/db";

/**
 * Replacing a resume prunes facts the new one does not support, or stale numbers from the
 * previous resume keep auto-filling applications while still looking valid.
 *
 * The dangerous edge is an empty extraction. Ollama returning nothing — because it is
 * down, slow, or simply had a bad run — must not be read as "this candidate has no
 * facts" and wipe good data. The guard returns before touching the database, which is
 * what makes this testable without one.
 */
test("an empty extraction prunes nothing and never reaches the database", async () => {
  const result = await upsertCandidateFacts({
    userId: "11111111-1111-1111-1111-111111111111",
    resumeVersionId: "22222222-2222-2222-2222-222222222222",
    facts: [],
  });

  assert.deepEqual(result, { written: [], pruned: [] });
});

test("the return shape always reports both what was written and what was dropped", async () => {
  // Callers log the pruned keys; a bare array would silently lose that.
  const result = await upsertCandidateFacts({
    userId: "11111111-1111-1111-1111-111111111111",
    resumeVersionId: "22222222-2222-2222-2222-222222222222",
    facts: [],
  });

  assert.ok(Array.isArray(result.written));
  assert.ok(Array.isArray(result.pruned));
});
