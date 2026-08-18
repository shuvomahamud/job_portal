import assert from "node:assert/strict";
import test from "node:test";
import { computedAnswerFor, isComputedQuestion } from "../src/formfill/computedAnswers";

// Fixed so the test is not written on the one day of the year it would flake, and so the
// exact formatted string is a real assertion rather than "some digits appeared".
const fixedNow = new Date(2026, 7, 18); // August 18 2026 — a single-digit month/day case.

test("today's date is recognised under the wording actually seen live", () => {
  // "Today's Date *" is the literal live case — an open pending question on a real
  // application, the whole reason this module exists.
  assert.equal(isComputedQuestion("Today's Date *"), true);
  assert.equal(isComputedQuestion("Today's date"), true);
  assert.equal(isComputedQuestion("Current Date"), true);
  assert.equal(isComputedQuestion("Date of Application"), true);
  assert.equal(isComputedQuestion("Date Signed"), true);
});

test("a question that merely mentions a date is not swept up", () => {
  // Getting this wrong in the other direction is worse: it would make a real fact —
  // when the candidate is available to start, when they were born — into something
  // silently overwritten with today's date instead of asked or looked up.
  assert.equal(isComputedQuestion("Available start date"), false);
  assert.equal(isComputedQuestion("Date of birth"), false);
  assert.equal(isComputedQuestion("Notice period"), false);
});

test("a plain text field gets the zero-padded US format", () => {
  const result = computedAnswerFor({ labelText: "Today's Date *", inputType: "text" }, fixedNow);
  assert.deepEqual(result, {
    value: "08/18/2026",
    reason: "Computed today's date; never a stored fact to look up.",
  });
});

test("a native date input gets ISO, the one format fill() will actually accept", () => {
  const result = computedAnswerFor({ labelText: "Date Signed", inputType: "date" }, fixedNow);
  assert.equal(result?.value, "2026-08-18");
});

test("an unrelated field returns null rather than a guess", () => {
  assert.equal(computedAnswerFor({ labelText: "Expected salary", inputType: "text" }, fixedNow), null);
});
