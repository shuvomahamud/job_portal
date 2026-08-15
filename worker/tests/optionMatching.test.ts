import assert from "node:assert/strict";
import test from "node:test";
import {
  bestOptionIndex,
  comparableOption,
  optionMatches,
  withoutPhoneDialCode,
} from "../src/formfill/optionMatching";

test("optionMatches requires every answer token to hit an option", () => {
  assert.equal(optionMatches(["Yes", "No"], "Yes"), true);
  assert.equal(optionMatches(["Remote", "Hybrid"], "On-site"), false);
  assert.equal(optionMatches(["Remote", "Hybrid", "On-site"], "Remote, Hybrid"), true);
});

test("bestOptionIndex matches a phone-country row that appends a dial code", () => {
  assert.equal(bestOptionIndex(["Afghanistan+93", "United States+1"], "United States"), 1);
  assert.equal(withoutPhoneDialCode("United States+1"), "united states");
});
