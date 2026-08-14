import assert from "node:assert/strict";
import test from "node:test";
import { adapterFor } from "../src/apply/applySteps";

/** Minimal page stand-in: body text plus whichever challenge elements are visible. */
function fakePage(bodyText: string, visibleChallenge = false) {
  return {
    url: () => "https://smartapply.indeed.com/beta/indeedapply/form/profile-location",
    locator(selector: string) {
      const isChallengeSelector = selector.includes("recaptcha");
      return {
        innerText: async () => bodyText,
        count: async () => (isChallengeSelector && visibleChallenge ? 1 : 0),
        nth: () => ({ isVisible: async () => visibleChallenge }),
      };
    },
  } as never;
}

const indeed = adapterFor("indeed");

test("Indeed's own apply form is not a challenge", async () => {
  // The exact false positive: an ordinary "Add your location" step carries a reCAPTCHA
  // notice in the footer, and matching the bare word "captcha" declared it blocked. The
  // run stopped, an alert fired, and the browser sat on a form nobody was filling while
  // thirty-five eligible postings waited behind it.
  const body = [
    "Add your location",
    "We'll save these details to your profile.",
    "Fields marked with (*) are required.",
    "Country United States Zip code City, state Street address",
    "This site is protected by reCAPTCHA and the Google Privacy Policy apply.",
  ].join(" ");

  const result = await indeed.detectBlocked(fakePage(body));
  assert.equal(result.blocked, false, result.reason);
});

test("a visible challenge widget is still caught", async () => {
  const result = await indeed.detectBlocked(fakePage("Add your location", true));
  assert.equal(result.blocked, true);
});

test("explicit human-verification wording is still caught", async () => {
  const result = await indeed.detectBlocked(
    fakePage("Additional Verification Required. Please verify you are human to continue."),
  );
  assert.equal(result.blocked, true);
});

test("an access-denied wall is still caught", async () => {
  const result = await indeed.detectBlocked(
    fakePage("Access Denied. You do not have permission to view this page."),
  );
  assert.equal(result.blocked, true);
});
