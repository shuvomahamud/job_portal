import assert from "node:assert/strict";
import test from "node:test";
import { boolFromEnv, browserChannelFromEnv } from "../src/config";

test("environment boolean parser treats explicit false strings as false", () => {
  assert.equal(boolFromEnv(true).parse("false"), false);
  assert.equal(boolFromEnv(true).parse("0"), false);
});

test("environment boolean parser accepts explicit true strings and defaults", () => {
  assert.equal(boolFromEnv(false).parse("true"), true);
  assert.equal(boolFromEnv(false).parse("1"), true);
  assert.equal(boolFromEnv(false).parse(undefined), false);
});

test("browser channel distinguishes installed Chrome from explicit bundled Chromium", () => {
  assert.equal(browserChannelFromEnv.parse("chrome"), "chrome");
  assert.equal(browserChannelFromEnv.parse("bundled"), undefined);
  assert.equal(browserChannelFromEnv.parse(undefined), undefined);
});
