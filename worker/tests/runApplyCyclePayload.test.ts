import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { MAX_APPLICATIONS_PER_RUN } from "../../src/lib/runLimits";

const payloadSchema = z
  .object({
    phase: z.enum(["discover", "apply"]).optional(),
    maxJobs: z.number().int().min(1).max(MAX_APPLICATIONS_PER_RUN).optional(),
    mode: z.enum(["dry_run", "fill_only", "fill_and_submit"]).optional(),
    matchingCommandIds: z.array(z.string().uuid()).max(50).optional(),
    attempt: z.number().int().min(0).max(20).optional(),
    parentCommandId: z.string().uuid().optional(),
  })
  .strict();

test("run_apply_cycle payload accepts discover and apply phases", () => {
  assert.equal(payloadSchema.parse({}).phase, undefined);
  assert.equal(payloadSchema.parse({ phase: "apply", attempt: 2 }).attempt, 2);
  assert.throws(() => payloadSchema.parse({ phase: "nope" }));
});

test("run_apply_cycle payload accepts the shared per-run ceiling", () => {
  assert.equal(
    payloadSchema.parse({ phase: "discover", maxJobs: MAX_APPLICATIONS_PER_RUN }).maxJobs,
    MAX_APPLICATIONS_PER_RUN,
  );
  assert.throws(() =>
    payloadSchema.parse({ phase: "discover", maxJobs: MAX_APPLICATIONS_PER_RUN + 1 }),
  );
});
