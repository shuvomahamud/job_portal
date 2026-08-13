import assert from "node:assert/strict";
import test from "node:test";
import { isPersistedAnswerId, markAnswersUsed } from "../src/formfill/answerBank";

/**
 * application_answers.id is a uuid column. Any synthesized answer id that reaches the
 * usage-counter update errors in Postgres with "invalid input syntax for type uuid".
 * The apply runner swallows that error to protect the application, so the failure is
 * silent — which is exactly why it needs a test.
 */
test("only real application_answers uuids count as persisted", () => {
  assert.equal(isPersistedAnswerId("d290f1ee-6c54-4b01-90e6-d701748f0851"), true);
  assert.equal(isPersistedAnswerId("D290F1EE-6C54-4B01-90E6-D701748F0851"), true);

  for (const synthesized of [
    "profile:city",
    "common:d290f1ee-6c54-4b01-90e6-d701748f0851",
    "fact:d290f1ee-6c54-4b01-90e6-d701748f0851",
    "derived:salary:expected_salary",
    "derived:salary:desired_rate",
    "",
    "not-a-uuid",
  ]) {
    assert.equal(
      isPersistedAnswerId(synthesized),
      false,
      `${synthesized} must never reach a uuid column`,
    );
  }
});

test("markAnswersUsed issues no query when every id is synthesized", async () => {
  let queried = false;
  const spy = {
    update() {
      queried = true;
      throw new Error("markAnswersUsed must not query for synthesized ids");
    },
  };

  await markAnswersUsed(
    [
      "profile:city",
      "fact:d290f1ee-6c54-4b01-90e6-d701748f0851",
      "derived:salary:expected_salary",
    ],
    spy as never,
  );
  assert.equal(queried, false);
});

test("a mixed batch keeps only the persisted uuid", () => {
  const kept = [
    "derived:salary:expected_salary",
    "d290f1ee-6c54-4b01-90e6-d701748f0851",
    "profile:zip",
  ].filter(isPersistedAnswerId);
  assert.deepEqual(kept, ["d290f1ee-6c54-4b01-90e6-d701748f0851"]);
});
