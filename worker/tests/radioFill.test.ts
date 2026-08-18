import assert from "node:assert/strict";
import test from "node:test";
import { fillDetectedField, fieldLooksAnswered } from "../src/apply/fillField";
import type { DetectedField } from "../src/formfill/types";

const human = { typingDelayMs: () => 0 };

function radioField(over: Partial<DetectedField> = {}): DetectedField {
  return {
    id: "work-type",
    selector: "#work-type-full-time",
    tagName: "input",
    inputType: "radio",
    labelText: "What type of work are you looking for?",
    normalizedQuestion: "what type of work are you looking for",
    placeholder: "",
    ariaLabel: "",
    name: "work-type",
    idAttribute: "work-type-full-time",
    required: true,
    options: ["Full-time", "Part-time", "Contract"],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "unknown",
    riskLevel: "LOW",
    confidence: 0.5,
    ...over,
  };
}

function fakeRadioFrame() {
  const checked: string[] = [];
  const bySelector = (selector: string) => {
    const group = selector.includes('[name="work-type"]');
    const controls = group
      ? ["#work-type-full-time", "#work-type-part-time", "#work-type-contract"]
      : [selector];
    const nth = (index: number) => ({
      scrollIntoViewIfNeeded: async () => {},
      check: async () => {
        if (index < 0 || index >= controls.length) {
          throw new Error(`radio option index ${index} is out of range for ${controls.length} matched controls.`);
        }
        checked.push(controls[index]!);
      },
    });
    return {
      count: async () => controls.length,
      nth,
      first: () => nth(0),
    };
  };
  return {
    frame: { locator: bySelector } as never,
    checked,
  };
}

test("a named radio group is filled by name, not the first option's id", async () => {
  const { frame, checked } = fakeRadioFrame();
  const result = await fillDetectedField(frame, radioField(), "Contract", human);
  assert.equal(result.ok, true);
  assert.deepEqual(checked, ["#work-type-contract"]);
});

test("an out-of-range radio asks instead of crashing the apply", async () => {
  const frame = {
    locator: (selector: string) => ({
      count: async () => (selector.startsWith("#") ? 1 : 1),
      nth: (index: number) => ({
        scrollIntoViewIfNeeded: async () => {},
        check: async () => {
          throw new Error(`radio option index ${index} is out of range for 1 matched controls.`);
        },
      }),
      first: () => ({
        scrollIntoViewIfNeeded: async () => {},
        check: async () => {},
      }),
    }),
  } as never;
  const result = await fillDetectedField(
    frame,
    radioField({ name: "", selector: "#work-type-full-time" }),
    "Contract",
    human,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("out of range"));
});

test("a radio the person already selected is treated as answered", () => {
  assert.equal(fieldLooksAnswered(radioField({ currentValue: "Yes" })), true);
  assert.equal(fieldLooksAnswered(radioField({ currentValue: "" })), false);
});
