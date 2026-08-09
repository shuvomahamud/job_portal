import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

const payloadSchema = z
  .object({
    phase: z.enum(["discover", "apply"]).optional(),
    maxJobs: z.number().int().min(1).max(50).optional(),
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
