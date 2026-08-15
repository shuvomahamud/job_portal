import assert from "node:assert/strict";
import test from "node:test";
import {
  looksLikeTransientLoad,
  shouldTreatPageAsUnchangedStall,
  verifyIdentityBeforeSubmit,
  waitOutTransientLoad,
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
 * results via getByText, arbitrary CSS-selector locators via locator, visible body text
 * via locator("body").innerText, and per-field controls that fillDetectedField can
 * click, type into, and read back.
 */
function fakeFrame(options: {
  textMatches?: RegExp[];
  textVisible?: boolean;
  spinnerVisible?: boolean | (() => boolean);
  pageText?: string;
  reviewContactName?: string | null;
} = {}) {
  const calls: string[] = [];
  const textMatches = options.textMatches ?? [];
  let lastTyped = "";
  const spinnerIsVisible = () =>
    typeof options.spinnerVisible === "function"
      ? options.spinnerVisible()
      : Boolean(options.spinnerVisible);

  const fieldControl = {
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { calls.push("click"); },
    fill: async (v: string) => {
      lastTyped = v;
      calls.push(`fill:${v}`);
    },
    pressSequentially: async (v: string) => {
      lastTyped = v;
      calls.push(`type:${v}`);
    },
    press: async () => {},
    innerText: async () => "",
    inputValue: async () => lastTyped,
    count: async () => 1,
    first: () => fieldControl,
    isVisible: async () => true,
    nth: () => fieldControl,
  };
  const spinnerControl = {
    ...fieldControl,
    count: async () => (spinnerIsVisible() ? 1 : 0),
    first: () => spinnerControl,
    isVisible: async () => spinnerIsVisible(),
  };
  const bodyControl = {
    ...fieldControl,
    innerText: async () => options.pageText ?? "",
    count: async () => 1,
    first: () => bodyControl,
    isVisible: async () => Boolean(options.pageText),
  };

  const frame = {
    url: () => "https://smartapply.indeed.com/beta/indeedapply/form/review",
    locator: (selector: string) => {
      if (selector === "body") return bodyControl;
      if (selector.includes("progressbar") || selector.includes("spinner")) return spinnerControl;
      return fieldControl;
    },
    getByText: (matcher: RegExp | string) => {
      const matched = (() => {
        if (typeof matcher === "string") {
          return textMatches.some((re) => re.test(matcher));
        }
        return textMatches.some((re) => re.source === matcher.source);
      })();
      const control = {
        count: async () => (matched ? 1 : 0),
        first: () => control,
        isVisible: async () => matched && (options.textVisible ?? true),
      };
      return control;
    },
    evaluate: async () => options.reviewContactName ?? null,
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
  const { frame } = fakeFrame({
    textMatches: [/preparing (your )?review|please wait|processing your|submitting your|loading\b|one moment/i],
  });
  assert.equal(await looksLikeTransientLoad(frame), true);
});

test("hidden 'Preparing review' text is not treated as a loading screen", async () => {
  const { frame } = fakeFrame({
    textMatches: [/preparing (your )?review|please wait|processing your|submitting your|loading\b|one moment/i],
    textVisible: false,
  });
  assert.equal(await looksLikeTransientLoad(frame), false);
});

test("an ordinary unchanged page is not mistaken for a loading screen", async () => {
  const { frame } = fakeFrame({});
  assert.equal(await looksLikeTransientLoad(frame), false);
});

test("waitOutTransientLoad polls on a time budget until the overlay clears", async () => {
  let remaining = 3;
  const { frame } = fakeFrame({ spinnerVisible: () => remaining > 0 });
  let polls = 0;
  const result = await waitOutTransientLoad(frame, {
    budgetMs: 5_000,
    pollMs: 10,
    sleep: async () => {
      polls += 1;
      remaining -= 1;
    },
  });
  assert.equal(result, "cleared");
  assert.equal(polls, 3);
});

test("waitOutTransientLoad times out without requiring extra form steps", async () => {
  const { frame } = fakeFrame({ spinnerVisible: true });
  const result = await waitOutTransientLoad(frame, {
    budgetMs: 30,
    pollMs: 10,
    sleep: async () => {},
  });
  assert.equal(result, "timeout");
});

test("waitOutTransientLoad aborts as soon as the halt flag is raised", async () => {
  const { frame } = fakeFrame({ spinnerVisible: true });
  const result = await waitOutTransientLoad(frame, {
    budgetMs: 5_000,
    pollMs: 10,
    shouldHalt: async () => true,
    sleep: async () => {
      throw new Error("must not sleep after halt");
    },
  });
  assert.equal(result, "aborted");
});

test("a review page that finished loading is not stalled just because it still has no fields", () => {
  // Indeed's review step: spinner and review share an empty field fingerprint and URL.
  // Submit is a button, so it never changes that fingerprint.
  assert.equal(
    shouldTreatPageAsUnchangedStall({
      clickedWithoutProgress: true,
      fingerprint: "|https://smartapply.indeed.com/review",
      previousFingerprint: "|https://smartapply.indeed.com/review",
      justClearedTransientLoad: true,
    }),
    false,
  );
  assert.equal(
    shouldTreatPageAsUnchangedStall({
      clickedWithoutProgress: true,
      fingerprint: "|https://smartapply.indeed.com/review",
      previousFingerprint: "|https://smartapply.indeed.com/review",
      justClearedTransientLoad: false,
    }),
    true,
  );
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

test("both configured names must be confirmed even if only the first field is on the page", async () => {
  const { frame } = fakeFrame({ pageText: "Review your application" });
  const fields = [field({ fieldCategory: "first_name", currentValue: "Md Mahamudul Hasan" })];
  const result = await verifyIdentityBeforeSubmit(
    frame,
    fields,
    human,
    "Md Mahamudul Hasan",
    "Khan",
  );
  assert.equal(result.verified, false);
  assert.match(result.verified ? "" : result.reason, /name \/ contact information row/i);
});

test("a missing last-name field is accepted when the Contact name row matches the profile", async () => {
  const { frame } = fakeFrame({ reviewContactName: "Md Mahamudul Hasan Khan" });
  const fields = [field({ fieldCategory: "first_name", currentValue: "Md Mahamudul Hasan" })];
  const result = await verifyIdentityBeforeSubmit(
    frame,
    fields,
    human,
    "Md Mahamudul Hasan",
    "Khan",
  );
  assert.deepEqual(result, { verified: true, corrected: false });
});

test("no editable field, but a Name row matches the profile: verified without guessing", async () => {
  const { frame } = fakeFrame({ reviewContactName: "Md Mahamudul Hasan Khan" });
  const result = await verifyIdentityBeforeSubmit(frame, [], human, "Md Mahamudul Hasan", "Khan");
  assert.deepEqual(result, { verified: true, corrected: false });
});

test("a resume filename is not accepted as the contact name", async () => {
  const { frame } = fakeFrame({
    pageText: "Contact name: Shuvo Mahamud\nResume: Md Mahamudul Hasan Khan.pdf",
    reviewContactName: "Shuvo Mahamud",
  });
  const result = await verifyIdentityBeforeSubmit(frame, [], human, "Md Mahamudul Hasan", "Khan");
  assert.equal(result.verified, false);
  assert.match(result.verified ? "" : result.reason, /does not match the candidate profile/i);
});

test("hidden name text is not confirmation", async () => {
  const { frame } = fakeFrame({
    pageText: "Review your application",
    textMatches: [/^Md Mahamudul Hasan Khan$/],
  });
  const result = await verifyIdentityBeforeSubmit(frame, [], human, "Md Mahamudul Hasan", "Khan");
  assert.equal(result.verified, false);
  assert.match(result.verified ? "" : result.reason, /name \/ contact information row/i);
});

test("no editable field and no Name row: refused rather than submitted blind", async () => {
  const { frame } = fakeFrame({});
  const result = await verifyIdentityBeforeSubmit(frame, [], human, "Md Mahamudul Hasan", "Khan");
  assert.equal(result.verified, false);
  assert.match(result.verified ? "" : result.reason, /name \/ contact information row/i);
});

test("no profile name on file at all is its own distinct refusal", async () => {
  const { frame } = fakeFrame({});
  const result = await verifyIdentityBeforeSubmit(frame, [], human, null, null);
  assert.equal(result.verified, false);
  assert.match(result.verified ? "" : result.reason, /no first or last name/i);
});
