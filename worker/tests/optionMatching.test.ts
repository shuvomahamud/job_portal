import assert from "node:assert/strict";
import test from "node:test";
import {
  bestOptionIndex,
  comparableOption,
  optionMatches,
} from "../src/formfill/optionMatching";

test("optionMatches requires every answer token to hit an option", () => {
  assert.equal(optionMatches(["Yes", "No"], "Yes"), true);
  assert.equal(optionMatches(["Remote", "Hybrid"], "On-site"), false);
  assert.equal(optionMatches(["Remote", "Hybrid", "On-site"], "Remote, Hybrid"), true);
});

test("bestOptionIndex returns -1 when ambiguous", () => {
  assert.equal(bestOptionIndex(["Yes", "No"], "Yes"), 0);
  assert.equal(bestOptionIndex(["Male", "Female", "Prefer not to say"], "Male"), 0);
  assert.equal(bestOptionIndex(["New York City", "New York State"], "New York"), -1);
  assert.equal(comparableOption("Prefer not to say"), "decline");
});
