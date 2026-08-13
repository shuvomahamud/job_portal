import assert from "node:assert/strict";
import test from "node:test";
import { detectBrowserBlocker } from "../src/browser/blockerDetection";
import type { PageLike } from "../src/browser/playwrightTypes";

function page(
  url: string,
  body: string,
  challengeElements: Array<{ visible: boolean }> = [],
): PageLike {
  return {
    url: () => url,
    locator: (selector: string) => {
      const elements = selector === "body" ? [{ visible: true }] : challengeElements;
      const locator = {
        innerText: async () => (selector === "body" ? body : ""),
        count: async () => elements.length,
        nth: (index: number) => ({
          ...locator,
          isVisible: async () => elements[index]?.visible ?? false,
        }),
        isVisible: async () => elements[0]?.visible ?? false,
      };
      return locator;
    },
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
    page("https://www.dice.com/jobs?q=.NET", "Please wait", [{ visible: true }]),
    "dice",
  );
  assert.equal(blocker?.kind, "captcha");
});

test("ignores invisible background reCAPTCHA frames on a normal results page", async () => {
  const blocker = await detectBrowserBlocker(
    page(
      "https://www.indeed.com/jobs?q=.NET",
      "Senior .NET Engineer at Acme Apply now. This site is protected by reCAPTCHA and the Google Privacy Policy applies.",
      [{ visible: false }, { visible: false }],
    ),
    "indeed",
  );
  assert.equal(blocker, null);
});

test("does not mistake a normal result page for a blocker", async () => {
  const blocker = await detectBrowserBlocker(
    page("https://www.dice.com/jobs?q=.NET", "Senior .NET Engineer at Acme"),
    "dice",
  );
  assert.equal(blocker, null);
});
