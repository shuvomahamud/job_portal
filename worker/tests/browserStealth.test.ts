import assert from "node:assert/strict";
import test from "node:test";
import { browserStealthOptions } from "../src/browser/session";

test("automation switches are always disabled", () => {
  const options = browserStealthOptions({});
  assert.deepEqual(options.args, ["--disable-blink-features=AutomationControlled"]);
  assert.deepEqual(options.ignoreDefaultArgs, ["--enable-automation"]);
});

test("no channel means Playwright's bundled Chromium", () => {
  assert.equal("channel" in browserStealthOptions({}), false);
  assert.equal("channel" in browserStealthOptions({ JOB_BROWSER_CHANNEL: "" }), false);
});

test("a configured channel selects the installed browser", () => {
  assert.equal(browserStealthOptions({ JOB_BROWSER_CHANNEL: "chrome" }).channel, "chrome");
});
