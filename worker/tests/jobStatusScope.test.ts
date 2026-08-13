import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_STATUSES,
  JOB_STATUSES,
  PER_USER_JOB_STATUSES,
  isPerUserJobStatus,
} from "../../src/lib/constants";

/**
 * `jobs` is shared across users and has no user_id, so a status describing one
 * candidate's outcome must never be stored there. These tests pin the split so a new
 * status cannot quietly land on the wrong side of it.
 */
test("every per-user status is a real job status", () => {
  for (const status of PER_USER_JOB_STATUSES) {
    assert.ok(
      (JOB_STATUSES as readonly string[]).includes(status),
      `${status} is not in JOB_STATUSES`,
    );
  }
});

test("every per-user status also exists as an application status", () => {
  // The jobs filter resolves these through applications, so both lists must agree.
  for (const status of PER_USER_JOB_STATUSES) {
    assert.ok(
      (APPLICATION_STATUSES as readonly string[]).includes(status),
      `${status} has no matching application status to resolve against`,
    );
  }
});

test("discovery statuses stay on the shared jobs row", () => {
  for (const status of ["new", "needs_review", "reviewing", "ready_to_apply", "archived"]) {
    assert.equal(
      isPerUserJobStatus(status),
      false,
      `${status} describes the posting, not a candidate's outcome`,
    );
  }
});

test("outcome statuses are recognised as per-user", () => {
  for (const status of ["applied", "interview", "offer", "rejected"]) {
    assert.equal(isPerUserJobStatus(status), true);
  }
});
