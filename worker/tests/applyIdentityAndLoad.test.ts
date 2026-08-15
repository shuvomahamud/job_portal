import assert from "node:assert/strict";
import test from "node:test";
import {
  looksLikeTransientLoad,
  verifyIdentityBeforeSubmit,
} from "../src/apply/applyRunner";
import type { DetectedField } from "../src/formfill/types";

const human = { typingDelayMs: () => 0 };

function field(over: Partial<DetectedField> = {}): DetectedField {
  return {
    id: "f1",
    selector: "#first-name",
    tagName: "input",
    inputType: "text",
    labelText: "First name",
    normalizedQuestion: "first name",
    placeholder: "",
    ariaLabel: "",
    name: "first-name",
    idAttribute: "first-name",
    required: true,
    options: [],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "first_name",
    riskLevel: "LOW",
    confidence: 0.95,
    ...over,
  };
}

/**
 * A frame stand-in general enough for both functions under test: arbitrary text-search
 * results via getByText, arbitrary CSS-selector locators via locator, and per-field
 * controls that fillDetectedField can click and type into.
 */
function fakeFrame(options: {
  textMatches?: RegExp[];
  spinnerVisible?: boolean;
} = {}) {
  const calls: string[] = [];
  const textMatches = options.textMatches ?? [];

  const fieldControl = {
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { calls.push("click"); },
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    pressSequentially: async (v: string) => { calls.push(`type:${v}`); },
    press: async () => {},
    innerText: async () => "",
    count: async () => 1,
    first: () => fieldControl,
    isVisible: async () => true,
    nth: () => fieldControl,
  };
  const spinnerControl = {
    ...fieldControl,
    count: async () => (options.spinnerVisible ? 1 : 0),
    first: () => spinnerControl,
    isVisible: async () => Boolean(options.spinnerVisible),
  };

  const frame = {
    url: () => "https://smartapply.indeed.com/beta/indeedapply/form/review",
    locator: (selector: string) =>
      selector.includes("progressbar") || selector.includes("spinner") ? spinnerControl : fieldControl,
    getByText: (matcher: RegExp | string) => ({
      count: async () => {
        if (typeof matcher === "string") {
          return textMatches.some((re) => re.test(matcher)) ||
            textMatches.length === 0 && false
            ? 1
            : 0;
        }
        return textMatches.some((re) => re.source === matcher.source) ? 1 : 0;
      },
    }),
  };
  return { frame: frame as never, calls };
}

// ---- looksLikeTransientLoad ----

test("a visible spinner is recognised as a transient load, not a stall", async () => {
  const { frame } = fakeFrame({ spinnerVisible: true });
  assert.equal(await looksLikeTransientLoad(frame), true);
});

test("Indeed's 'Preparing review' text is recognised as a transient load", async () => {
  // The exact false positive: this screen carries no fillable fields, so its fingerprint
  // matches the previous step's and the stall check used to fire on the very first repeat.
  const { frame } = fakeFrame({ textMatches: [/preparing (your )?review|please wait|processing your|submitting your|loading\b|one moment/i] });
  assert.equal(await looksLikeTransientLoad(frame), true);
});

test("an ordinary unchanged page is not mistaken for a loading screen", async () => {
  const { frame } = fakeFrame({});
  assert.equal(await looksLikeTransientLoad(frame), false);
});

// ---- verifyIdentityBeforeSubmit ----

test("an editable name field showing the wrong value is corrected, not just flagged", async () => {
  const { frame, calls } = fakeFrame({});
  const fields = [
    field({ fieldCategory: "first_name", currentValue: "Shuvo" }),
    field({ fieldCategory: "last_name", currentValue: "Mahamud", selector: "#last-name" }),
  ];
  const result = await verifyIdentityBeforeSubmit(
    frame,
    fields,
    human,
    "Md Mahamudul Hasan",
    "Khan",
  );
  assert.deepEqual(result, { verified: true, corrected: true });
  assert.ok(calls.some((c) => c.startsWith("fill:")), "cleared before typing the correct value");
});

test("an editable name field already showing the right value needs no correction", async () => {
  const { frame, calls } = fakeFrame({});
  const fields = [field({ fieldCategory: "first_name", currentValue: "Md Mahamudul Hasan" })];
  const result = await verifyIdentityBeforeSubmit(frame, fields, human, "Md Mahamudul Hasan", null);
  assert.deepEqual(result, { verified: true, corrected: false });
  assert.equal(calls.length, 0, "nothing was touched");
});

test("no editable field, but the expected name is visible: verified without guessing", async () => {
  // The resumed-past-contact-info case: no name inputs on this page at all, only a review
  // screen. Matching visible text is real confirmation, not an assumption.
  const { frame } = fakeFrame({ textMatches: [/^Md Mahamudul Hasan Khan$/] });
  const result = await verifyIdentityBeforeSubmit(frame, [], human, "Md Mahamudul Hasan", "Khan");
  assert.deepEqual(result, { verified: true, corrected: false });
});

test("no editable field and no matching text: refused rather than submitted blind", async () => {
  // This is the live bug: the flow resumed past contact-info, no field was ever touched,
  // and the account's own stale profile name would otherwise have gone out unexamined.
  const { frame } = fakeFrame({});
  const result = await verifyIdentityBeforeSubmit(frame, [], human, "Md Mahamudul Hasan", "Khan");
  assert.equal(result.verified, false);
  assert.match(result.verified ? "" : result.reason, /could not find/i);
});

test("no profile name on file at all is its own distinct refusal", async () => {
  const { frame } = fakeFrame({});
  const result = await verifyIdentityBeforeSubmit(frame, [], human, null, null);
  assert.equal(result.verified, false);
  assert.match(result.verified ? "" : result.reason, /no first or last name/i);
});
