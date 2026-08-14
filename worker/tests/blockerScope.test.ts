import assert from "node:assert/strict";
import test from "node:test";

/**
 * The rule the applier applies when choosing what to work on next.
 *
 * Extracted so the decision can be tested without a database: the query itself is a
 * `notInArray` on the job's source, and what matters is which postings survive it.
 */
export function selectableSources(
  allSources: string[],
  blockedSources: string[],
): string[] {
  return allSources.filter((source) => !blockedSources.includes(source));
}

test("a blocked board does not stop the other one", () => {
  // The failure this replaces: any open alert halted every application. An Indeed CAPTCHA
  // stopped Dice too, and when that alert turned out to be a phantom it stopped everything
  // for hours with thirty-five eligible postings waiting.
  assert.deepEqual(selectableSources(["indeed", "dice"], ["indeed"]), ["dice"]);
  assert.deepEqual(selectableSources(["indeed", "dice"], ["dice"]), ["indeed"]);
});

test("nothing blocked means nothing skipped", () => {
  assert.deepEqual(selectableSources(["indeed", "dice"], []), ["indeed", "dice"]);
});

test("both blocked leaves nothing to apply to", () => {
  // Correct, and distinct from the old behaviour: here applying really is waiting on the
  // user for every board, rather than being stopped by one unrelated alert.
  assert.deepEqual(selectableSources(["indeed", "dice"], ["indeed", "dice"]), []);
});

test("an alert for a site we never apply to is harmless", () => {
  assert.deepEqual(selectableSources(["indeed", "dice"], ["linkedin"]), ["indeed", "dice"]);
});
