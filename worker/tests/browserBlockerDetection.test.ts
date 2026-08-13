import assert from "node:assert/strict";
import test from "node:test";
import { detectBrowserBlocker } from "../src/browser/blockerDetection";
import type { PageLike } from "../src/browser/playwrightTypes";

function page(url: string, body: string, challengeElements = 0): PageLike {
  return {
    url: () => url,
    locator: (selector: string) => ({
      innerText: async () => (selector === "body" ? body : ""),
      count: async () => (selector === "body" ? 1 : challengeElements),
    }),
  } as unknown as PageLike;
}

test("detects a redirect to a job-site login", async () => {
  const blocker = await detectBrowserBlocker(
    page("https://secure.indeed.com/account/login", "Welcome back"),
    "indeed",
  );
  assert.equal(blocker?.kind, "login_required");
  assert.equal(blocker?.site, "indeed");
});

test("detects CAPTCHA elements even when the page text is vague", async () => {
  const blocker = await detectBrowserBlocker(
    page("https://www.dice.com/jobs?q=.NET", "Please wait", 1),
    "dice",
  );
  assert.equal(blocker?.kind, "captcha");
});

test("does not mistake a normal result page for a blocker", async () => {
  const blocker = await detectBrowserBlocker(
    page("https://www.dice.com/jobs?q=.NET", "Senior .NET Engineer at Acme"),
    "dice",
  );
  assert.equal(blocker, null);
});
