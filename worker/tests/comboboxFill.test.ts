import assert from "node:assert/strict";
import test from "node:test";
import {
  autocompleteQueryCandidates,
  fieldAlreadyHasValue,
  fillDetectedField,
  pendingAsksWhenFormRefused,
} from "../src/apply/fillField";
import type { DetectedField } from "../src/formfill/types";

const human = { typingDelayMs: () => 0 };

function field(over: Partial<DetectedField> = {}): DetectedField {
  return {
    id: "f1",
    selector: "#location-fields-locality-input",
    tagName: "input",
    inputType: "select",
    labelText: "City, state",
    normalizedQuestion: "city state",
    placeholder: "",
    ariaLabel: "",
    name: "location-locality",
    idAttribute: "location-fields-locality-input",
    required: true,
    options: ["Hoboken, NJ", "Houston, TX"],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "city",
    riskLevel: "LOW",
    confidence: 0.95,
    ...over,
  };
}

type FakeFrameOptions = {
  optionLabels?: string[];
  optionsForQuery?: (query: string) => string[];
};

/**
 * Records what was done to the control, so the interaction can be asserted.
 * Option rows follow the last typed query so location fallbacks can be tested.
 */
function fakeFrame(input: string[] | FakeFrameOptions = []) {
  const config: FakeFrameOptions = Array.isArray(input) ? { optionLabels: input } : input;
  const calls: string[] = [];
  let typed = "";
  let current = "";

  const labelsNow = () => {
    if (config.optionsForQuery) return config.optionsForQuery(typed);
    return config.optionLabels ?? [];
  };

  const control = {
    scrollIntoViewIfNeeded: async () => {
      calls.push("scroll");
    },
    click: async () => {
      calls.push("click");
    },
    fill: async (v: string) => {
      typed = v;
      current = v;
      calls.push(`fill:${v}`);
    },
    pressSequentially: async (v: string) => {
      typed = v;
      current = v;
      calls.push(`type:${v}`);
    },
    press: async (k: string) => {
      calls.push(`press:${k}`);
    },
    inputValue: async () => current,
    selectOption: async () => {
      calls.push("selectOption");
      // Exactly what Playwright throws on a role=combobox that is not a <select>.
      throw new Error("Element is not a <select> element");
    },
    innerText: async () => "",
    count: async () => 1,
    first: () => control,
    nth: (i: number) => ({
      innerText: async () => labelsNow()[i] ?? "",
      click: async () => {
        const label = labelsNow()[i] ?? "";
        current = label;
        calls.push(`choose:${label}`);
      },
    }),
  };
  const frame = {
    locator: (selector: string) => {
      if (selector.includes('role="option"')) {
        return {
          ...control,
          count: async () => labelsNow().length,
        };
      }
      return control;
    },
  };
  return { frame: frame as never, calls };
}

test("an ARIA combobox is typed into, not sent to selectOption", async () => {
  // The bug this pins: the detector reports role="combobox" as inputType "select", which is
  // right for classification and wrong for filling. Calling selectOption threw "Element is
  // not a <select> element", the required city field stayed empty, Continue would not
  // advance, and every Indeed application died as "stalled" with the tab closing on an
  // almost-complete form.
  const { frame, calls } = fakeFrame(["Hoboken, NJ", "Houston, TX"]);
  const result = await fillDetectedField(frame, field(), "Hoboken, NJ", human);

  assert.equal(result.ok, true);
  assert.ok(!calls.includes("selectOption"), "never treated as a native <select>");
  assert.ok(calls.some((c) => c.startsWith("type:")), "typed into like a person would");
  assert.ok(calls.includes("choose:Hoboken, NJ"), "picked the matching row from the listbox");
});

test("a real select still goes through selectOption", async () => {
  // The fix must not cost native dropdowns their fast path.
  const { frame, calls } = fakeFrame([]);
  await fillDetectedField(frame, field({ tagName: "select" }), "Hoboken, NJ", human).catch(
    () => undefined,
  );
  assert.ok(calls.includes("selectOption"));
});

test("a combobox with no matching row does not press Enter", async () => {
  const { frame, calls } = fakeFrame(["Somewhere else"]);
  const result = await fillDetectedField(frame, field(), "Hoboken, NJ", human);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("invalid autocomplete value"));
  assert.ok(!calls.includes("press:Enter"), "typed text is not a selected option");
});

test("No results found is not treated as an autocomplete option", async () => {
  const { frame, calls } = fakeFrame(["No results found"]);
  const result = await fillDetectedField(frame, field(), "South Richmond Hill", human);
  assert.equal(result.ok, false);
  assert.ok(!calls.some((c) => c.startsWith("choose:")));
  assert.ok(!calls.includes("press:Enter"));
});

test("a city combobox falls back to city, state then ZIP and clicks a real row", async () => {
  const { frame, calls } = fakeFrame({
    optionsForQuery: (query) => {
      if (query === "South Richmond Hill") return ["No results found"];
      if (query === "South Richmond Hill, NY") return ["South Richmond Hill, NY"];
      if (query === "11419") return ["South Richmond Hill, NY 11419"];
      return [];
    },
  });
  const result = await fillDetectedField(frame, field(), "South Richmond Hill", human, {
    state: "NY",
    postalCode: "11419",
  });
  assert.equal(result.ok, true);
  assert.ok(calls.includes("type:South Richmond Hill"));
  assert.ok(calls.includes("type:South Richmond Hill, NY"));
  assert.ok(calls.includes("choose:South Richmond Hill, NY"));
  assert.ok(!calls.includes("type:11419"), "ZIP is only used when city, state also fails");
  assert.ok(!calls.includes("press:Enter"));
});

test("ZIP is tried when city and city, state both have no rows", async () => {
  const { frame, calls } = fakeFrame({
    optionsForQuery: (query) => {
      if (query === "11419") return ["South Richmond Hill, NY 11419"];
      return ["No results found"];
    },
  });
  const result = await fillDetectedField(frame, field(), "South Richmond Hill", human, {
    state: "NY",
    postalCode: "11419",
  });
  assert.equal(result.ok, true);
  assert.ok(calls.includes("type:South Richmond Hill"));
  assert.ok(calls.includes("type:South Richmond Hill, NY"));
  assert.ok(calls.includes("type:11419"));
  assert.ok(calls.includes("choose:South Richmond Hill, NY 11419"));
});

test("location candidates are city, then city with state, then ZIP", () => {
  assert.deepEqual(
    autocompleteQueryCandidates("South Richmond Hill", field(), {
      state: "NY",
      postalCode: "11419",
    }),
    ["South Richmond Hill", "South Richmond Hill, NY", "11419"],
  );
});

test("a pre-filled field is cleared before typing, not appended to", async () => {
  // Indeed pre-fills contact fields from the account profile. Typing on top of that sent
  // "ShuvoMd Mahamudul Hasan" and "MahamudKhan" to real employers — an application with a
  // mangled name is worse than no application.
  const { frame, calls } = fakeFrame([]);
  await fillDetectedField(
    frame,
    field({ inputType: "text", tagName: "input", fieldCategory: "first_name", options: [] }),
    "Md Mahamudul Hasan",
    human,
  );
  const cleared = calls.indexOf("fill:");
  const typed = calls.findIndex((c) => c.startsWith("type:"));
  assert.ok(cleared >= 0, "the field is emptied first");
  assert.ok(typed > cleared, "and only then typed into");
});

test("a plain city input still selects a Google Places row, not just typed text", async () => {
  const { frame, calls } = fakeFrame(["Latham, NY, USA", "Latham, IL, USA"]);
  const result = await fillDetectedField(
    frame,
    field({
      inputType: "text",
      tagName: "input",
      labelText: "What is your current city of residence?",
      fieldCategory: "city",
      options: [],
    }),
    "Latham",
    human,
    { state: "NY", postalCode: "12110" },
  );
  assert.equal(result.ok, true);
  assert.ok(calls.includes("choose:Latham, NY, USA"));
});

test("ambiguous Latham rows are disambiguated by the chosen address state", async () => {
  const { frame, calls } = fakeFrame([
    "Latham, NY, USA",
    "Latham, IL, USA",
    "Latham, OH, USA",
    "Latham, KS, USA",
    "Latham, MO, USA",
  ]);
  const result = await fillDetectedField(frame, field({ options: [] }), "Latham", human, {
    state: "NY",
    postalCode: "12110",
  });
  assert.equal(result.ok, true);
  assert.ok(calls.includes("choose:Latham, NY, USA"));
});

test("a refused city combobox becomes a pending question instead of a silent stall", () => {
  const city = field({ currentValue: "South Richmond Hill" });
  const asks = pendingAsksWhenFormRefused([city]);
  assert.equal(asks.length, 1);
  assert.ok(asks[0]!.reason.includes("invalid autocomplete value"));
});

test("empty required fields on a refused step are asked before combobox fallbacks", () => {
  const asks = pendingAsksWhenFormRefused([
    field({
      fieldCategory: "custom_short_answer",
      inputType: "text",
      tagName: "input",
      labelText: "Are you able to work on-site?",
      currentValue: "",
      required: true,
    }),
    field({ currentValue: "South Richmond Hill" }),
  ]);
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.field.labelText, "Are you able to work on-site?");
});

test("a computed question is never raised to a human, even from the refused-form fallback", () => {
  // The live bug: "Today's Date" reached the dashboard as a pending question through this
  // exact path — a blunt "is it empty and required" scan that has no idea some questions
  // do not need anyone, human or model, to answer them.
  const asks = pendingAsksWhenFormRefused([
    field({
      fieldCategory: "unknown",
      inputType: "text",
      tagName: "input",
      labelText: "Today's Date *",
      currentValue: "",
      required: true,
    }),
  ]);
  assert.equal(asks.length, 0);
});

test("a computed question does not hide a genuine one on the same refused page", () => {
  const asks = pendingAsksWhenFormRefused([
    field({
      fieldCategory: "unknown",
      inputType: "text",
      tagName: "input",
      labelText: "Today's Date *",
      currentValue: "",
      required: true,
    }),
    field({
      fieldCategory: "custom_short_answer",
      inputType: "text",
      tagName: "input",
      labelText: "Are you able to work on-site?",
      currentValue: "",
      required: true,
    }),
  ]);
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.field.labelText, "Are you able to work on-site?");
});

test("an already-selected Indeed phone country is left alone", async () => {
  const { frame, calls } = fakeFrame(["Afghanistan+93", "United States+1"]);
  const country = field({
    tagName: "div",
    inputType: "select",
    fieldCategory: "country",
    labelText: "Select country United States",
    currentValue: "United States",
    options: ["Afghanistan+93", "United States+1"],
  });
  assert.equal(fieldAlreadyHasValue(country, "United States"), true);
  const result = await fillDetectedField(frame, country, "United States", human);
  assert.equal(result.ok, true);
  assert.ok(!calls.includes("click"));
});

test("a phone-country combobox matches United States to United States+1", async () => {
  const { frame, calls } = fakeFrame(["Afghanistan+93", "Albania+355", "United States+1"]);
  const result = await fillDetectedField(
    frame,
    field({
      tagName: "div",
      inputType: "select",
      fieldCategory: "country",
      labelText: "Select country",
      currentValue: "",
      options: ["Afghanistan+93", "United States+1"],
    }),
    "United States",
    human,
  );
  assert.equal(result.ok, true);
  assert.ok(calls.includes("choose:United States+1"));
});

test("a zip that already shows the desired value is accepted without a list row", async () => {
  const { frame } = fakeFrame(["No results found"]);
  const result = await fillDetectedField(
    frame,
    field({
      fieldCategory: "zip",
      labelText: "Zip code",
      currentValue: "",
      options: [],
    }),
    "12110",
    human,
  );
  assert.equal(result.ok, true);
});
