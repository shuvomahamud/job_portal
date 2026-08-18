import assert from "node:assert/strict";
import test from "node:test";
import { detectBrowserBlocker } from "../src/browser/blockerDetection";
import type { PageLike } from "../src/browser/playwrightTypes";

function page(
  url: string,
  body: string,
  challengeElements: Array<{ visible: boolean }> = [],
  frameBodies: string[] = [],
): PageLike {
  const root = (text: string, elements: Array<{ visible: boolean }>) => ({
    locator: (selector: string) => {
      const matched = selector === "body" ? [{ visible: true }] : elements;
      const locator = {
        innerText: async () => (selector === "body" ? text : ""),
        count: async () => matched.length,
        nth: (index: number) => ({
          ...locator,
          isVisible: async () => matched[index]?.visible ?? false,
        }),
        isVisible: async () => matched[0]?.visible ?? false,
      };
      return locator;
    },
  });
  return {
    url: () => url,
    ...root(body, challengeElements),
    frames: () =>
      frameBodies.map((text) => ({
        ...root(text, []),
        isDetached: () => false,
      })),
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

test("ignores Dice's optional login prompt on a normal results page", async () => {
  const blocker = await detectBrowserBlocker(
    page(
      "https://www.dice.com/jobs?q=.NET",
      "Senior .NET Engineer at Acme. To see how well you match this job, please log in or create an account.",
    ),
    "dice",
  );
  assert.equal(blocker, null);
});

test("still detects an explicit login gate", async () => {
  const blocker = await detectBrowserBlocker(
    page("https://www.dice.com/jobs?q=.NET", "Please log in to continue"),
    "dice",
  );
  assert.equal(blocker?.kind, "login_required");
});

test("detects Indeed's I'm not a robot checkbox wording", async () => {
  const blocker = await detectBrowserBlocker(
    page("https://smartapply.indeed.com/beta/indeedapply/form/review", "I'm not a robot"),
    "indeed",
  );
  assert.equal(blocker?.kind, "captcha");
});

test("detects Indeed's image-select challenge inside a reCAPTCHA iframe", async () => {
  const blocker = await detectBrowserBlocker(
    page(
      "https://smartapply.indeed.com/beta/indeedapply/form/review",
      "Review your application. This site is protected by reCAPTCHA.",
      [],
      ["Select all images with cars. Click verify once there are none left."],
    ),
    "indeed",
  );
  assert.equal(blocker?.kind, "captcha");
});

test("a visible recaptcha bframe on the review page is a challenge", async () => {
  const blocker = await detectBrowserBlocker(
    page(
      "https://smartapply.indeed.com/beta/indeedapply/form/review",
      "Review your application. Submit your application.",
      [{ visible: true }],
    ),
    "indeed",
  );
  assert.equal(blocker?.kind, "captcha");
});
