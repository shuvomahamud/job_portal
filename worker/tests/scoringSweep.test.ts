import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { MAX_DISCOVERY_RESULTS_PER_COMMAND } from "../../src/lib/runLimits";

/**
 * Mirrors the run_local_llm_extraction payload contract. A sweep is distinguished by what
 * it leaves out, so the schema accepting those omissions is the whole feature.
 */
const payloadSchema = z
  .object({
    parentCommandId: z.uuid().optional(),
    candidateProfileId: z.uuid(),
    jobIds: z.array(z.uuid()).min(1).max(MAX_DISCOVERY_RESULTS_PER_COMMAND).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    promptVersion: z.literal("job-match-prompt-v1"),
    policyVersion: z.literal("job-match-policy-v2"),
    targetRoleId: z.uuid(),
    resumeVersionId: z.uuid(),
    reason: z.string().optional(),
  })
  .strict();

const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

const sweep = {
  candidateProfileId: uuid(1),
  promptVersion: "job-match-prompt-v1" as const,
  policyVersion: "job-match-policy-v2" as const,
  targetRoleId: uuid(2),
  resumeVersionId: uuid(3),
  reason: "cycle started",
};

test("a sweep needs neither a job list nor a parent search", () => {
  const parsed = payloadSchema.parse(sweep);
  assert.equal(parsed.jobIds, undefined);
  assert.equal(parsed.parentCommandId, undefined);
});

test("the queueing reason is accepted", () => {
  // The schema is strict, so a field the queuer sets but the handler has not declared
  // fails the command outright — which is exactly how the first sweeps died.
  assert.equal(payloadSchema.parse(sweep).reason, "cycle started");
});

test("the old fixed-list form still parses", () => {
  // find_matching_jobs used to queue scoring with the exact survivors of its own search.
  // Existing queued commands must keep working across the deploy.
  const parsed = payloadSchema.parse({
    ...sweep,
    parentCommandId: uuid(4),
    jobIds: [uuid(5), uuid(6)],
  });
  assert.equal(parsed.jobIds?.length, 2);
});

test("an empty job list is still rejected", () => {
  // Absent means "work it out yourself". Empty means a caller computed nothing and should
  // not have queued at all — silently treating that as a sweep would hide the bug.
  assert.throws(() => payloadSchema.parse({ ...sweep, jobIds: [] }));
});

test("a sweep cannot exceed the discovery ceiling", () => {
  const tooMany = Array.from({ length: MAX_DISCOVERY_RESULTS_PER_COMMAND + 1 }, (_, i) =>
    uuid(i % 9),
  );
  assert.throws(() => payloadSchema.parse({ ...sweep, jobIds: tooMany }));
});
