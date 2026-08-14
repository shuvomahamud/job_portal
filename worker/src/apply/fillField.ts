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

  // Only a real <select> can be driven by selectOption. The detector reports anything with
  // role="combobox" as inputType "select" too, which is right for classification and wrong
  // here: Indeed's location step uses <input role="combobox"> for city and a <div> for
  // country, and calling selectOption on either throws "Element is not a <select> element".
  //
  // That single mismatch was enough to stop every Indeed application. The city field is
  // required, so it stayed empty, Continue would not advance, and the run gave up as
  // "stalled" — closing the tab on a form that had been filled in almost completely.
  if (field.tagName === "select") {
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

  if (field.inputType === "select") {
    await fillAriaCombobox(frame, locator.first(), field, value, human);
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

/**
 * Fills a control that behaves like a dropdown without being a <select>.
 *
 * These are everywhere in modern application forms — Indeed's city and country fields are
 * both one — and they only respond to being operated the way a person would: focus it,
 * type, wait for the list to populate, choose the matching row. Setting the value directly
 * leaves the page's own state untouched, so the form still believes the field is empty.
 *
 * Falls back to committing the typed text with Enter, which is what the editable ones
 * accept, and leaves the value in place for a plain text input.
 */
async function fillAriaCombobox(
  frame: FrameLike,
  target: ReturnType<FrameLike["locator"]>,
  field: DetectedField,
  value: string,
  human: HumanTyping,
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await target.click({ timeout: 5_000 }).catch(() => undefined);

  // A div-based combobox has nothing to type into; opening it is the whole interaction.
  const editable = field.tagName === "input" || field.tagName === "textarea";
  if (editable) {
    await target.fill("").catch(() => undefined);
    await target.pressSequentially(value, { delay: human.typingDelayMs() }).catch(async () => {
      await target.fill(value).catch(() => undefined);
    });
  }

  // The listbox is rendered outside the control, so it is looked for on the frame. Given a
  // moment to populate: these lists are usually fetched, not static.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const optionSelector = '[role="option"], [role="listbox"] li, [role="listbox"] div[data-value]';
  const options = frame.locator(optionSelector);
  const count = await options.count().catch(() => 0);

  if (count > 0) {
    const labels: string[] = [];
    for (let index = 0; index < Math.min(count, 40); index += 1) {
      labels.push((await options.nth(index).innerText().catch(() => "")).trim());
    }
    const best = bestOptionIndex(labels, value);
    if (best >= 0) {
      await options.nth(best).click({ timeout: 5_000 }).catch(() => undefined);
      return;
    }
  }

  // Nothing matched: commit what was typed. An editable combobox generally accepts it, and
  // for anything else this leaves the field no worse than it was.
  if (editable) await target.press("Enter").catch(() => undefined);
}
