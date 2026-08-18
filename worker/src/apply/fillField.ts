import type { FrameLike } from "../browser/playwrightTypes";
import {
  bestOptionIndex,
  comparableOption,
  withoutPhoneDialCode,
} from "../formfill/optionMatching";
import type { DetectedField } from "../formfill/types";
import { computedAnswerFor } from "../formfill/computedAnswers";

export type HumanTyping = {
  typingDelayMs: () => number;
};

export type FillFieldResult = { ok: true } | { ok: false; reason: string };

export type FillFieldExtras = {
  state?: string | null;
  postalCode?: string | null;
  /** Historical job/education cities (Copenhagen) are not in Indeed's US Places list. */
  acceptTypedLocation?: boolean;
};

const NO_AUTOCOMPLETE_RESULT = /no results found|no matches|nothing found|no options/i;

export async function fillDetectedField(
  frame: FrameLike,
  field: DetectedField,
  value: string,
  human: HumanTyping,
  extras: FillFieldExtras = {},
): Promise<FillFieldResult> {
  if (field.inputType === "file" || field.fieldCategory === "resume_upload") {
    throw new Error("File fields are not filled by fillDetectedField; use setInputFiles separately.");
  }

  if (fieldAlreadyHasValue(field, value)) return { ok: true };

  if (field.inputType === "radio" || field.inputType === "checkbox") {
    return fillChoiceControl(frame, field, value);
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
      return { ok: true };
    } catch {
      // fall through to value match
    }
    await target.selectOption({ value });
    return { ok: true };
  }

  if (field.inputType === "select" || isLocationAutocompleteField(field)) {
    return fillAriaCombobox(frame, locator.first(), field, value, human, extras);
  }

  const target = locator.first();
  await target.scrollIntoViewIfNeeded();
  await target.click();
  // Clear before typing. Indeed pre-fills contact fields from the account's own profile,
  // and typing on top of that appended instead of replacing: "Shuvo" + "Md Mahamudul
  // Hasan" became "ShuvoMd Mahamudul Hasan", and the surname went out as "MahamudKhan".
  //
  // Every application that got past this page carried a mangled name to a real employer,
  // which is worse than not applying at all.
  await target.fill("").catch(() => undefined);
  await target.pressSequentially(value, { delay: human.typingDelayMs() });
  return { ok: true };
}

function cssAttr(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Radio/checkbox `selector` is often `#first-option-id` even when `options` lists the
 * whole group. Locate by `name` so choosing option 2 is not "index 2 of 1 controls".
 * A mismatch asks instead of crashing the apply.
 */
async function fillChoiceControl(
  frame: FrameLike,
  field: DetectedField,
  value: string,
): Promise<FillFieldResult> {
  const kind = field.inputType;
  const groupSelector = field.name
    ? `input[type="${kind}"][name="${cssAttr(field.name)}"]`
    : field.selector;
  let locator = frame.locator(groupSelector);
  let count = await locator.count();
  if (!count && groupSelector !== field.selector) {
    locator = frame.locator(field.selector);
    count = await locator.count();
  }
  if (!count) {
    return { ok: false, reason: `Field selector matched nothing: ${field.selector}` };
  }
  const index = bestOptionIndex(field.options, value);
  if (index < 0) {
    return { ok: false, reason: `No unambiguous ${kind} option matched "${value}".` };
  }
  if (index >= count) {
    return {
      ok: false,
      reason: `${kind} option index ${index} is out of range for ${count} matched controls.`,
    };
  }
  const option = locator.nth(index);
  await option.scrollIntoViewIfNeeded();
  await option.check();
  return { ok: true };
}

export function isAriaCombobox(field: DetectedField): boolean {
  return field.inputType === "select" && field.tagName !== "select";
}

function looksLikeCountryOptionList(value: string): boolean {
  return (value.match(/\+\d+/g) ?? []).length > 3;
}

export function fieldAlreadyHasValue(field: DetectedField, desired: string): boolean {
  const want = desired.trim();
  if (!want) return false;
  const current = String(field.currentValue ?? "").trim();
  if (current && !looksLikeCountryOptionList(current)) {
    if (comparableOption(current) === comparableOption(want)) return true;
    if (withoutPhoneDialCode(current) === withoutPhoneDialCode(want)) return true;
  }
  if (field.fieldCategory === "country" || /\bselect country\b/i.test(field.labelText)) {
    const label = field.labelText.trim();
    if (label && !looksLikeCountryOptionList(label)) {
      return withoutPhoneDialCode(label).includes(withoutPhoneDialCode(want));
    }
  }
  return false;
}

/** True when the page already has an answer, so Resume should not re-ask. */
export function fieldLooksAnswered(field: DetectedField): boolean {
  const current = String(field.currentValue ?? "").trim();
  if (!current) return false;
  return !looksLikeCountryOptionList(current);
}

/** Dice city-of-residence is a plain <input> with Google Places, not role=combobox. */
export function isLocationAutocompleteField(field: DetectedField): boolean {
  if (field.tagName === "select") return false;
  if (field.inputType === "radio" || field.inputType === "checkbox" || field.inputType === "file") {
    return false;
  }
  if (["city", "zip", "address"].includes(field.fieldCategory)) return true;
  return /\bcity of residence\b|\blocality\b|\bcity,?\s*state\b/i.test(
    `${field.labelText} ${field.normalizedQuestion}`,
  );
}

export function autocompleteQueryCandidates(
  value: string,
  field: DetectedField,
  extras: FillFieldExtras = {},
): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const queries = [trimmed];
  const isLocation =
    field.fieldCategory === "city" ||
    /\bcity\b|locality|location/i.test(`${field.labelText} ${field.normalizedQuestion}`);
  if (isLocation) {
    const state = extras.state?.trim();
    if (state && !/,/.test(trimmed) && !/\d{5}/.test(trimmed)) {
      queries.push(`${trimmed}, ${state}`);
    }
    const zip = extras.postalCode?.trim();
    if (zip && /^\d{5}(-\d{4})?$/.test(zip)) queries.push(zip);
  }
  return [...new Set(queries)];
}

/**
 * When Continue/Next is ignored, the fill loop never runs, so unanswered or rejected
 * fields never become dashboard questions. Turn the refused step into asks instead of
 * a silent stall — especially ARIA city comboboxes that still show typed text.
 */
export function pendingAsksWhenFormRefused(
  fields: DetectedField[],
): Array<{ field: DetectedField; reason: string }> {
  // This is the fallback path taken when the form has already refused to advance, and it
  // used to flag anything empty without asking whether it even needed a person: "Today's
  // Date" was raised as a pending question here even after the normal fill pass had its
  // own fix for exactly that question, because this scan never consulted it — it only
  // looked at whether the field was currently empty, not whether it was answerable.
  // A field this module can compute is never a real unknown, however it got here empty.
  const emptyRequired = fields.filter(
    (field) =>
      field.required &&
      field.fieldCategory !== "resume_upload" &&
      !String(field.currentValue ?? "").trim() &&
      !computedAnswerFor(field),
  );
  if (emptyRequired.length) {
    return emptyRequired.map((field) => ({
      field,
      reason: "The form would not advance; this required field is empty.",
    }));
  }
  return fields
    .filter((field) => {
      if (!field.required || !isAriaCombobox(field)) return false;
      if (!String(field.currentValue ?? "").trim()) return false;
      return (
        field.fieldCategory === "city" ||
        /\bcity\b|locality|location|zip|postal/i.test(
          `${field.labelText} ${field.normalizedQuestion}`,
        )
      );
    })
    .map((field) => ({
      field,
      reason: `invalid autocomplete value: the form did not accept "${field.currentValue}".`,
    }));
}

/**
 * Fills a control that behaves like a dropdown without being a <select>.
 *
 * These are everywhere in modern application forms — Indeed's city and country fields are
 * both one — and they only respond to being operated the way a person would: focus it,
 * type, wait for the list to populate, choose the matching row. Setting the value directly
 * leaves the page's own state untouched, so the form still believes the field is empty.
 *
 * A typed value is not a selection. Dice's city autocomplete showed "No results found"
 * for "South Richmond Hill"; pressing Enter left the text visible, the form ignored Next,
 * and the run stalled without ever asking for a better location.
 */
async function fillAriaCombobox(
  frame: FrameLike,
  target: ReturnType<FrameLike["locator"]>,
  field: DetectedField,
  value: string,
  human: HumanTyping,
  extras: FillFieldExtras,
): Promise<FillFieldResult> {
  const queries = autocompleteQueryCandidates(value, field, extras);
  for (const query of queries) {
    if (await tryAutocompleteQuery(frame, target, field, query, human, extras)) {
      return { ok: true };
    }
  }
  const live = (await target.inputValue().catch(() => "")).trim() || String(field.currentValue ?? "").trim();
  if (typedValueIsAcceptable(field, live, value, extras)) {
    return { ok: true };
  }
  const attempted = queries.join(" / ") || value;
  return {
    ok: false,
    reason: `invalid autocomplete value: no matching option for "${attempted}".`,
  };
}

function typedValueIsAcceptable(
  field: DetectedField,
  live: string,
  desired: string,
  extras: FillFieldExtras = {},
): boolean {
  if (!live.trim() || !desired.trim()) return false;
  // A bare current-city name is not a selected Places row ("Latham" vs "Latham, NY, USA").
  // Historical resume locations may be abroad and will never appear in that list.
  if (field.fieldCategory === "city" && !extras.acceptTypedLocation) return false;
  if (comparableOption(live) === comparableOption(desired)) return true;
  if (withoutPhoneDialCode(live) === withoutPhoneDialCode(desired)) return true;
  return comparableOption(live).includes(comparableOption(desired));
}

async function tryAutocompleteQuery(
  frame: FrameLike,
  target: ReturnType<FrameLike["locator"]>,
  field: DetectedField,
  query: string,
  human: HumanTyping,
  extras: FillFieldExtras,
): Promise<boolean> {
  await target.scrollIntoViewIfNeeded();
  await target.click({ timeout: 5_000 }).catch(() => undefined);

  const editable = field.tagName === "input" || field.tagName === "textarea";
  if (editable) {
    await target.fill("").catch(() => undefined);
    await target.pressSequentially(query, { delay: human.typingDelayMs() }).catch(async () => {
      await target.fill(query).catch(() => undefined);
    });
  }

  const options = await waitForAutocompleteOptions(frame);
  const count = await options.count().catch(() => 0);
  const labels = count > 0 ? await optionLabels(options, count) : [];
  const usable = labels.map((label, index) => ({ label, index })).filter((item) => {
    return item.label && !NO_AUTOCOMPLETE_RESULT.test(item.label);
  });

  const best = usable.length
    ? bestOptionIndex(usable.map((item) => item.label), query)
    : -1;
  let chosen =
    best >= 0
      ? usable[best]!
      : pickLocationOption(usable, query, extras);

  if (!chosen && field.options.length) {
    const bankIndex = bestOptionIndex(field.options, query);
    if (bankIndex >= 0) {
      const wanted = field.options[bankIndex]!;
      chosen =
        usable.find(
          (item) =>
            comparableOption(item.label) === comparableOption(wanted) ||
            withoutPhoneDialCode(item.label) === withoutPhoneDialCode(wanted),
        ) ?? null;
      if (!chosen && typeof frame.getByRole === "function") {
        const countryName = wanted.split("+")[0]!.trim();
        const byName = frame.getByRole("option", { name: countryName });
        const nameCount = await byName.count().catch(() => 0);
        for (let index = 0; index < nameCount; index += 1) {
          const item = byName.nth(index);
          if (!(await item.isVisible({ timeout: 200 }).catch(() => false))) continue;
          await item.click({ timeout: 5_000 }).catch(() => undefined);
          await delay(200);
          return autocompleteLooksSelected(target, query, wanted);
        }
      }
    }
  }

  if (!chosen) return false;
  await options.nth(chosen.index).click({ timeout: 5_000 }).catch(() => undefined);
  await delay(200);
  return autocompleteLooksSelected(target, query, chosen.label);
}

const OPTION_SELECTOR =
  '[role="option"], [role="listbox"] li, [role="listbox"] div[data-value], .pac-item';

function pickLocationOption(
  usable: Array<{ label: string; index: number }>,
  query: string,
  extras: FillFieldExtras,
): { label: string; index: number } | null {
  const state = extras.state?.trim();
  if (!state) return null;
  const stateCmp = comparableOption(state);
  const withState = usable.filter((item) => comparableOption(item.label).includes(stateCmp));
  if (withState.length === 1) return withState[0]!;
  const queryCmp = comparableOption(query);
  const both = withState.filter((item) => comparableOption(item.label).includes(queryCmp));
  return both.length === 1 ? both[0]! : null;
}

async function waitForAutocompleteOptions(frame: FrameLike) {
  const deadline = Date.now() + 2_000;
  let sawPlaceholderAt: number | null = null;
  let options = frame.locator(OPTION_SELECTOR);
  while (Date.now() < deadline) {
    const count = await options.count().catch(() => 0);
    if (count > 0) {
      const labels = await optionLabels(options, count);
      if (labels.some((label) => label && !NO_AUTOCOMPLETE_RESULT.test(label))) return options;
      if (sawPlaceholderAt === null) sawPlaceholderAt = Date.now();
      if (Date.now() - sawPlaceholderAt >= 600) return options;
    }
    await delay(250);
    options = frame.locator(OPTION_SELECTOR);
  }
  return options;
}

async function optionLabels(
  options: ReturnType<FrameLike["locator"]>,
  count: number,
): Promise<string[]> {
  const labels: string[] = [];
  for (let index = 0; index < Math.min(count, 300); index += 1) {
    labels.push((await options.nth(index).innerText().catch(() => "")).trim());
  }
  return labels;
}

async function autocompleteLooksSelected(
  target: ReturnType<FrameLike["locator"]>,
  query: string,
  chosenLabel: string,
): Promise<boolean> {
  const live = (await target.inputValue().catch(() => "")).trim();
  // Div-based comboboxes often have no input value; a real option click is the selection.
  if (!live) return true;
  if (NO_AUTOCOMPLETE_RESULT.test(live)) return false;
  const liveCmp = comparableOption(live);
  const chosenCmp = comparableOption(chosenLabel);
  if (liveCmp && chosenCmp && (liveCmp === chosenCmp || liveCmp.includes(chosenCmp))) {
    return true;
  }
  const queryCmp = comparableOption(query);
  return Boolean(queryCmp && liveCmp !== queryCmp && liveCmp.includes(queryCmp));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
