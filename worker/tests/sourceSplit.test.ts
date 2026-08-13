import assert from "node:assert/strict";
import test from "node:test";
import {
  selectJobsWithinRunLimits,
  splitAcrossSources,
  type RunLimitCandidate,
} from "../src/apply/applyEligibility";

const candidate = (
  id: string,
  source: string,
  overrides: Partial<RunLimitCandidate> = {},
): RunLimitCandidate => ({
  jobId: id,
  targetRoleId: "role-1",
  source,
  ...overrides,
});

test("an even request splits evenly", () => {
  assert.deepEqual([...splitAcrossSources(50, ["indeed", "dice"])], [
    ["indeed", 25],
    ["dice", 25],
  ]);
});

test("an odd request gives the extra to the first board", () => {
  assert.deepEqual([...splitAcrossSources(51, ["indeed", "dice"])], [
    ["indeed", 26],
    ["dice", 25],
  ]);
  assert.deepEqual([...splitAcrossSources(1, ["indeed", "dice"])], [
    ["indeed", 1],
    ["dice", 0],
  ]);
});

test("one board takes the whole allowance", () => {
  assert.deepEqual([...splitAcrossSources(20, ["dice"])], [["dice", 20]]);
});

test("a run across both boards honours the split rather than the ranking", () => {
  // Indeed happens to hold every top score; without a per-board quota it would take the
  // entire run and Dice would never be applied to.
  const candidates = [
    ...Array.from({ length: 8 }, (_, i) => candidate(`indeed-${i}`, "indeed")),
    ...Array.from({ length: 8 }, (_, i) => candidate(`dice-${i}`, "dice")),
  ];
  const selected = selectJobsWithinRunLimits(candidates, 6, ["indeed", "dice"]);

  assert.equal(selected.length, 6);
  assert.equal(selected.filter((id) => id.startsWith("indeed")).length, 3);
  assert.equal(selected.filter((id) => id.startsWith("dice")).length, 3);
});

test("a board that runs short does not waste its share", () => {
  // Only one Dice posting is eligible; the run should still reach the requested total.
  const candidates = [
    ...Array.from({ length: 10 }, (_, i) => candidate(`indeed-${i}`, "indeed")),
    candidate("dice-0", "dice"),
  ];
  const selected = selectJobsWithinRunLimits(candidates, 6, ["indeed", "dice"]);

  assert.equal(selected.length, 6, "the leftover share is backfilled");
  assert.equal(selected.filter((id) => id.startsWith("dice")).length, 1);
  assert.equal(selected.filter((id) => id.startsWith("indeed")).length, 5);
});

test("a single-board run is unaffected by the split", () => {
  const candidates = Array.from({ length: 5 }, (_, i) => candidate(`indeed-${i}`, "indeed"));
  assert.equal(selectJobsWithinRunLimits(candidates, 3, ["indeed"]).length, 3);
});

test("legacy per-role values do not override the limit chosen for this run", () => {
  const candidates = [
    candidate("indeed-0", "indeed"),
    candidate("indeed-1", "indeed"),
    candidate("dice-0", "dice"),
  ];
  const selected = selectJobsWithinRunLimits(candidates, 6, ["indeed", "dice"]);
  assert.equal(selected.length, 3, "every eligible job can be used until the run limit");
});
