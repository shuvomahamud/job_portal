import type { FrameLike } from "../browser/playwrightTypes";
import { bestOptionIndex } from "../formfill/optionMatching";
import type { DetectedField } from "../formfill/types";

export type HumanTyping = {
  typingDelayMs: () => number;
};

export async function fillDetectedField(
  frame: FrameLike,
  field: DetectedField,
  value: string,
  human: HumanTyping,
): Promise<void> {
  if (field.inputType === "file" || field.fieldCategory === "resume_upload") {
    throw new Error("File fields are not filled by fillDetectedField; use setInputFiles separately.");
  }

  const locator = frame.locator(field.selector);
  const count = await locator.count();
  if (!count) throw new Error(`Field selector matched nothing: ${field.selector}`);

  if (field.tagName === "select" || field.inputType === "select") {
    const target = locator.first();
    await target.scrollIntoViewIfNeeded();
    try {
      await target.selectOption({ label: value });
      return;
    } catch {
      // fall through to value match
    }
    await target.selectOption({ value });
    return;
  }

  if (field.inputType === "radio" || field.inputType === "checkbox") {
    const index = bestOptionIndex(field.options, value);
    if (index < 0) {
      throw new Error(`No unambiguous ${field.inputType} option matched "${value}".`);
    }
    if (index >= count) {
      throw new Error(
        `${field.inputType} option index ${index} is out of range for ${count} matched controls.`,
      );
    }
    const option = locator.nth(index);
    await option.scrollIntoViewIfNeeded();
    await option.check();
    return;
  }

  const target = locator.first();
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await target.pressSequentially(value, { delay: human.typingDelayMs() });
}
