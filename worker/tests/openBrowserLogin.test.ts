import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceAccessVerification,
  type AccessVerificationState,
} from "../src/handlers/openBrowserLogin";

function advance(
  state: AccessVerificationState,
  accessIsClear: boolean,
  times: number,
) {
  let result = advanceAccessVerification(state, accessIsClear);
  for (let index = 1; index < times; index += 1) {
    result = advanceAccessVerification(result.state, accessIsClear);
  }
  return result;
}

test("does not accept a challenge that only disappears briefly", () => {
  const almostClear = advance(
    { phase: "before_reload", cleanChecks: 0 },
    true,
    2,
  );
  assert.equal(almostClear.action, "wait");

  const blockedAgain = advanceAccessVerification(almostClear.state, false);
  assert.deepEqual(blockedAgain.state, {
    phase: "before_reload",
    cleanChecks: 0,
  });
  assert.equal(blockedAgain.action, "wait");
});

test("requires a reload and five clean checks afterward", () => {
  const beforeReload = advance(
    { phase: "before_reload", cleanChecks: 0 },
    true,
    3,
  );
  assert.equal(beforeReload.action, "reload");
  assert.deepEqual(beforeReload.state, {
    phase: "after_reload",
    cleanChecks: 0,
  });

  const notYetVerified = advance(beforeReload.state, true, 4);
  assert.equal(notYetVerified.action, "wait");

  const verified = advanceAccessVerification(notYetVerified.state, true);
  assert.equal(verified.action, "verified");
});

test("a blocker after reload restarts the full verification sequence", () => {
  const afterReload: AccessVerificationState = {
    phase: "after_reload",
    cleanChecks: 4,
  };
  const blocked = advanceAccessVerification(afterReload, false);
  assert.deepEqual(blocked.state, {
    phase: "before_reload",
    cleanChecks: 0,
  });
  assert.equal(blocked.action, "wait");
});
