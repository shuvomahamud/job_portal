import assert from "node:assert/strict";
import test from "node:test";
import { shouldResumeDependentApplyPhase } from "../src/db";

const blockedCommandId = "944c4891-56b4-4a40-a1b3-f964ba27ff27";

test("resumes a pending apply phase that depends on the unblocked search", () => {
  assert.equal(
    shouldResumeDependentApplyPhase(
      {
        status: "pending",
        payloadJson: { phase: "apply", matchingCommandIds: [blockedCommandId] },
        resultJson: null,
      },
      blockedCommandId,
    ),
    true,
  );
});

test("resumes an apply phase that ended early because discovery failed", () => {
  assert.equal(
    shouldResumeDependentApplyPhase(
      {
        status: "completed",
        payloadJson: { phase: "apply", matchingCommandIds: [blockedCommandId] },
        resultJson: {
          message: "Discovery or scoring failed, so this cycle will not apply to stale jobs.",
        },
      },
      blockedCommandId,
    ),
    true,
  );
});

test("does not replay an apply phase that already performed normal work", () => {
  assert.equal(
    shouldResumeDependentApplyPhase(
      {
        status: "completed",
        payloadJson: { phase: "apply", matchingCommandIds: [blockedCommandId] },
        resultJson: { message: "Apply phase queued 20 job(s)." },
      },
      blockedCommandId,
    ),
    false,
  );
});
