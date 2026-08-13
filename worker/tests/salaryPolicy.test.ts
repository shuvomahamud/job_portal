import assert from "node:assert/strict";
import test from "node:test";
import {
  recommendSalaryAnswer,
  usesPostedRangeSalaryPolicy,
} from "../src/formfill/salaryPolicy";

test("dynamic salary derivation requires an explicit candidate policy marker", () => {
  assert.equal(
    usesPostedRangeSalaryPolicy(
      "[auto-posted-range-upper-85] Use the posting's explicit range.",
    ),
    true,
  );
  assert.equal(usesPostedRangeSalaryPolicy("Negotiable"), false);
  assert.equal(usesPostedRangeSalaryPolicy(null), false);
});

test("annual ranges target the upper end without exceeding the maximum", () => {
  const answer = recommendSalaryAnswer("$150,000 - $185,000 annually", "expected_salary");
  assert.ok(answer);
  assert.equal(answer.value, "180000");
  assert.equal(answer.period, "annual");
  assert.equal(answer.maximum, 185_000);
});

test("k-suffixed annual ranges are supported", () => {
  const answer = recommendSalaryAnswer("USD 140k–180k per year", "expected_salary");
  assert.ok(answer);
  assert.equal(answer.value, "174000");
});

test("hourly ranges produce a desired-rate answer", () => {
  const answer = recommendSalaryAnswer("$70-$90/hr", "desired_rate");
  assert.ok(answer);
  assert.equal(answer.value, "87");
  assert.equal(answer.period, "hourly");
});

test("period mismatches and missing ranges defer to a user question", () => {
  assert.equal(recommendSalaryAnswer("$70-$90/hr", "expected_salary"), null);
  assert.equal(recommendSalaryAnswer("Competitive", "expected_salary"), null);
  assert.equal(recommendSalaryAnswer(null, "expected_salary"), null);
});

test("implausible values are rejected", () => {
  assert.equal(recommendSalaryAnswer("$2,026 annually", "expected_salary"), null);
  assert.equal(recommendSalaryAnswer("$2-$5/hr", "desired_rate"), null);
});
