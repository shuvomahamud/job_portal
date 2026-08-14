import assert from "node:assert/strict";
import test from "node:test";
import { fillDetectedField } from "../src/apply/fillField";
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

/** Records what was done to the control, so the interaction can be asserted. */
function fakeFrame(optionLabels: string[]) {
  const calls: string[] = [];
  const control = {
    scrollIntoViewIfNeeded: async () => { calls.push("scroll"); },
    click: async () => { calls.push("click"); },
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    pressSequentially: async (v: string) => { calls.push(`type:${v}`); },
    press: async (k: string) => { calls.push(`press:${k}`); },
    selectOption: async () => {
      calls.push("selectOption");
      // Exactly what Playwright throws on a role=combobox that is not a <select>.
      throw new Error("Element is not a <select> element");
    },
    innerText: async () => "",
    count: async () => 1,
    first: () => control,
    nth: (i: number) => ({
      innerText: async () => optionLabels[i] ?? "",
      click: async () => { calls.push(`choose:${optionLabels[i]}`); },
    }),
  };
  const frame = {
    locator: (selector: string) => {
      if (selector.includes("role=\"option\"")) {
        return { ...control, count: async () => optionLabels.length };
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
  await fillDetectedField(frame, field(), "Hoboken, NJ", human);

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

test("a combobox with no matching row commits what was typed", async () => {
  const { frame, calls } = fakeFrame(["Somewhere else"]);
  await fillDetectedField(frame, field(), "Hoboken, NJ", human);
  assert.ok(calls.includes("press:Enter"), "editable comboboxes accept a typed value");
});
