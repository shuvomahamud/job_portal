import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerConfig } from "../src/config";
import {
  browserStealthOptions,
  openBrowserSession,
  resetCdpConnectionForTests,
} from "../src/browser/session";
import type {
  BrowserContextLike,
  BrowserLike,
  PlaywrightModule,
} from "../src/browser/playwrightTypes";

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

test("CDP sessions reuse one connection and never close the attached browser", async (t) => {
  resetCdpConnectionForTests();
  t.after(resetCdpConnectionForTests);

  let connectCalls = 0;
  let closeCalls = 0;
  const context = {
    pages: () => [],
    newPage: async () => ({}),
    close: async () => undefined,
  } as unknown as BrowserContextLike;
  const browser: BrowserLike = {
    contexts: () => [context],
    newContext: async () => context,
    isConnected: () => true,
    close: async () => {
      closeCalls += 1;
    },
  };
  const playwright = {
    chromium: {
      connectOverCDP: async () => {
        connectCalls += 1;
        return browser;
      },
      launchPersistentContext: async () => context,
    },
  } as PlaywrightModule;
  const cfg = {
    JOB_BROWSER_CDP_URL: "http://127.0.0.1:9222",
    JOB_BROWSER_CDP_MANAGE_PAGES: false,
    JOB_BROWSER_CDP_CONNECT_TIMEOUT_MS: 5_000,
    JOB_BROWSER_CDP_CLEANUP_TIMEOUT_MS: 1_000,
    JOB_BROWSER_HEADLESS: false,
    JOB_BROWSER_SLOW_MO_MS: 0,
    JOB_BROWSER_CHANNEL: "chrome",
  } as WorkerConfig;

  const first = await openBrowserSession(playwright, cfg);
  await first.close();
  const second = await openBrowserSession(playwright, cfg);
  await second.close();

  assert.equal(connectCalls, 1);
  assert.equal(closeCalls, 0);
});
