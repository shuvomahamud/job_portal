import { z } from "zod";
import type { FrameLike, PageLike } from "../browser/playwrightTypes";
import { classifyField } from "./fieldClassifier";
import { normalizeQuestion } from "./questionNormalizer";
import { getRiskLevel } from "./riskPolicy";
import { fieldBaseSchema } from "./schemas";
import type { DetectedField } from "./types";

export type FieldBase = Omit<DetectedField, "fieldCategory" | "riskLevel" | "confidence">;

/**
 * Serialised into the page by frame.evaluate.
 * MUST have zero imports and zero closure captures — the function body is
 * stringified and nothing from module scope survives the boundary.
 */
export function detectFieldBasesInPage(): FieldBase[] {
  const FIELD_SELECTOR =
    'input, textarea, select, [contenteditable="true"], [role="combobox"]';

  function cssEscape(value: string): string {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
    return value.replace(/["\\]/g, "\\$&");
  }

  function cleanText(value: string | null | undefined, maxLength = 500): string {
    return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function queryRoot(element: Element): Document | ShadowRoot {
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root : document;
  }

  function textFromIds(element: Element, ids: string): string {
    const root = queryRoot(element);
    return ids
      .split(/\s+/)
      .map((id) => root.querySelector(`#${cssEscape(id)}`)?.textContent)
      .filter(Boolean)
      .join(" ");
  }

  function directText(element: Element): string {
    return [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(" ");
  }

  function labelForId(element: Element, id: string): string {
    if (!id) return "";
    const labels = [
      ...queryRoot(element).querySelectorAll<HTMLLabelElement>("label[for]"),
    ];
    return cleanText(labels.find((label) => label.htmlFor === id)?.textContent);
  }

  function wrappingLabel(element: Element): string {
    return cleanText(element.closest("label")?.textContent);
  }

  function fieldsetLegend(element: Element): string {
    const fieldset = element.closest("fieldset");
    return cleanText(fieldset?.querySelector(":scope > legend")?.textContent);
  }

  function nearbySiblingText(element: Element): string {
    const parts: string[] = [];
    let sibling = element.previousElementSibling;
    let checked = 0;
    while (sibling && checked < 2) {
      if (!sibling.matches("input, textarea, select, button, script, style")) {
        parts.unshift(cleanText(sibling.textContent, 180));
      }
      sibling = sibling.previousElementSibling;
      checked += 1;
    }
    return cleanText(parts.filter(Boolean).join(" "), 300);
  }

  function parentQuestionText(element: Element): string {
    const parent = element.closest(
      ".field, .form-field, .question, .application-question, [data-field], [role=group], li, td, div",
    );
    if (!parent) return "";
    const candidates = [
      parent.querySelector("label")?.textContent,
      parent.querySelector("legend")?.textContent,
      parent.querySelector(
        ".label, .question, .question-title, .field-label, [data-automation-id*=label]",
      )?.textContent,
      directText(parent),
    ];
    return cleanText(candidates.filter(Boolean).join(" "), 400);
  }

  function extractOptionLabel(element: HTMLInputElement): string {
    return (
      labelForId(element, element.id) ||
      wrappingLabel(element) ||
      cleanText(element.getAttribute("aria-label")) ||
      cleanText(element.value)
    );
  }

  function extractLabelText(element: HTMLElement): string {
    const id = element.id;
    const ariaLabelledBy = element.getAttribute("aria-labelledby") ?? "";
    const grouped =
      element instanceof HTMLInputElement &&
      ["radio", "checkbox"].includes(element.type);
    const standardSources = [
      labelForId(element, id),
      wrappingLabel(element),
      ariaLabelledBy ? cleanText(textFromIds(element, ariaLabelledBy)) : "",
      cleanText(element.getAttribute("aria-label")),
      fieldsetLegend(element),
      parentQuestionText(element),
      cleanText(element.getAttribute("placeholder")),
      cleanText(element.getAttribute("name")?.replace(/[_-]+/g, " ")),
      cleanText(id.replace(/[_-]+/g, " ")),
    ];
    const sources = grouped
      ? [
          fieldsetLegend(element),
          ariaLabelledBy ? cleanText(textFromIds(element, ariaLabelledBy)) : "",
          parentQuestionText(element),
          ...standardSources,
        ]
      : standardSources;
    return sources.find((source) => source.length > 0) ?? "Unlabeled field";
  }

  function extractNearbyText(element: HTMLElement): string {
    const text = [fieldsetLegend(element), nearbySiblingText(element), parentQuestionText(element)]
      .filter(Boolean)
      .join(" ");
    return cleanText(text, 600);
  }

  function isVisible(element: HTMLElement): boolean {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    if (element.closest("[hidden]")) return false;
    const input = element as HTMLInputElement;
    // Custom resume widgets keep the native file input in the tree at opacity 0.
    // Treating that as invisible meant the upload was skipped, then a later detect
    // pass found a different positional input that was not attached.
    if (input.type === "file") {
      return !input.disabled;
    }
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      (style.opacity !== "" && Number(style.opacity) === 0)
    ) {
      return false;
    }
    if (input.type === "hidden") return false;
    return true;
  }

  function isFillable(element: HTMLElement): boolean {
    if (!isVisible(element)) return false;
    if (element.matches(":disabled, [readonly]")) return false;
    if (element instanceof HTMLInputElement) {
      return !["button", "submit", "reset", "image", "hidden", "password"].includes(element.type);
    }
    return !element.matches("button, [role=button]");
  }

  function uniqueSelector(element: HTMLElement): string {
    // Named radio/checkbox groups must share one selector. Preferring `#id` left
    // fill looking at a single control while `options` listed the whole group, so
    // choosing option index 2 threw and crashed the apply.
    if (
      element instanceof HTMLInputElement &&
      ["radio", "checkbox"].includes(element.type) &&
      element.name
    ) {
      return `input[type="${element.type}"][name="${cssEscape(element.name)}"]`;
    }
    if (element.id) return `#${cssEscape(element.id)}`;
    if (element instanceof HTMLInputElement && element.type === "file") {
      if (element.name) {
        const named = `input[type="file"][name="${cssEscape(element.name)}"]`;
        if (queryRoot(element).querySelectorAll(named).length === 1) return named;
      }
      const files = queryRoot(element).querySelectorAll('input[type="file"]');
      if (files.length === 1) return 'input[type="file"]';
    }
    const name = element.getAttribute("name");
    if (name) {
      const selector = `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      if (queryRoot(element).querySelectorAll(selector).length === 1) return selector;
    }
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      const parentElement: HTMLElement | null = current.parentElement;
      if (parentElement) {
        const siblings = [...parentElement.children].filter(
          (child) => child.tagName === current?.tagName,
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parentElement;
    }
    return parts.join(" > ");
  }

  function stableId(selector: string, question: string): string {
    const text = `${selector}|${question}`;
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `field-${(hash >>> 0).toString(36)}`;
  }

  function answerTypeFor(element: HTMLElement): string {
    if (element instanceof HTMLSelectElement) return "select";
    if (element instanceof HTMLTextAreaElement) return "textarea";
    if (element instanceof HTMLInputElement) {
      if (element.type === "radio") return "radio";
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "file") return "file";
    }
    if (element.getAttribute("role") === "combobox") return "select";
    return "text";
  }

  function elementOptions(element: HTMLElement): string[] {
    if (element instanceof HTMLSelectElement) {
      return [...element.options]
        .filter((option) => !option.disabled)
        .map((option) => option.text.trim())
        .filter(Boolean);
    }
    if (
      element instanceof HTMLInputElement &&
      ["radio", "checkbox"].includes(element.type) &&
      element.name
    ) {
      return [
        ...queryRoot(element).querySelectorAll<HTMLInputElement>(
          `input[type="${element.type}"][name="${cssEscape(element.name)}"]`,
        ),
      ]
        .filter(isVisible)
        .map(extractOptionLabel)
        .filter(Boolean);
    }
    const controls = element.getAttribute("aria-controls");
    if (controls) {
      const listbox = document.getElementById(controls);
      return [...(listbox?.querySelectorAll('[role="option"]') ?? [])]
        .map((option) => option.textContent?.trim() ?? "")
        .filter(Boolean);
    }
    return [];
  }

  function currentValue(element: HTMLElement): string {
    if (element instanceof HTMLSelectElement) {
      const selected = element.selectedOptions[0];
      if (!selected || !selected.value || selected.disabled) return "";
      return selected.text.trim();
    }
    if (element instanceof HTMLInputElement) {
      if (element.type === "file") return element.files?.length ? "File selected" : "";
      if (element.type === "radio" && element.name) {
        const checked = queryRoot(element).querySelector<HTMLInputElement>(
          `input[type="radio"][name="${cssEscape(element.name)}"]:checked`,
        );
        return checked ? extractOptionLabel(checked) : "";
      }
      if (element.type === "checkbox") {
        if (element.name) {
          return [
            ...queryRoot(element).querySelectorAll<HTMLInputElement>(
              `input[type="checkbox"][name="${cssEscape(element.name)}"]:checked`,
            ),
          ]
            .map(extractOptionLabel)
            .join(", ");
        }
        return element.checked ? extractOptionLabel(element) || "true" : "false";
      }
      return element.value;
    }
    if (element instanceof HTMLTextAreaElement) return element.value;
    return element.textContent?.trim() ?? "";
  }

  function collectFillable(root: ParentNode): HTMLElement[] {
    const found: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    const visit = (node: ParentNode) => {
      for (const element of [...node.querySelectorAll<HTMLElement>(FIELD_SELECTOR)]) {
        if (!seen.has(element) && isFillable(element)) {
          seen.add(element);
          found.push(element);
        }
      }
      for (const host of [...node.querySelectorAll("*")]) {
        if (host.shadowRoot) visit(host.shadowRoot);
      }
    };
    visit(root);
    return found;
  }

  const elements = collectFillable(document);
  const seenGroups = new Set<string>();
  const fields: FieldBase[] = [];

  for (const element of elements) {
    if (
      element instanceof HTMLInputElement &&
      ["radio", "checkbox"].includes(element.type) &&
      element.name
    ) {
      const groupKey = `${element.type}:${element.name}`;
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);
    }

    const labelText = extractLabelText(element);
    const selector = uniqueSelector(element);
    const normalizedQuestion = labelText.toLowerCase().replace(/\s+/g, " ").trim();
    fields.push({
      id: stableId(selector, normalizedQuestion),
      selector,
      tagName: element.tagName.toLowerCase(),
      inputType:
        element.getAttribute("role") === "combobox"
          ? "select"
          : element instanceof HTMLInputElement
            ? element.type
            : answerTypeFor(element),
      labelText,
      normalizedQuestion,
      placeholder: element.getAttribute("placeholder") ?? "",
      ariaLabel: element.getAttribute("aria-label") ?? "",
      name: element.getAttribute("name") ?? "",
      idAttribute: element.id,
      required:
        element.hasAttribute("required") ||
        element.getAttribute("aria-required") === "true" ||
        // An asterisk in the label counts. Indeed's screening questions set neither
        // attribute and mark the required ones with a "*" in their text — its own contact
        // page says "Fields marked with (*) are required" — so every one of them looked
        // optional, was skipped in silence, and then the form refused to advance with
        // nothing to explain why.
        /\*/.test(labelText),
      options: elementOptions(element),
      currentValue: currentValue(element),
      nearbyText: extractNearbyText(element),
    });
  }

  return fields;
}

/**
 * Playwright serialises the page function via Function#toString. Under tsx,
 * nested `function` declarations become `__name(fn, "fn")` calls that do not
 * exist in the browser — polyfill `__name` and eval the source as a string.
 */
export async function evaluatePageFunction<R>(frame: FrameLike, fn: () => R): Promise<R> {
  return frame.evaluate(
    `(() => { const __name = (target) => target; return (${fn.toString()})(); })()`,
  );
}

export async function detectFields(frame: FrameLike): Promise<DetectedField[]> {
  const raw = await evaluatePageFunction(frame, detectFieldBasesInPage);
  const bases = z.array(fieldBaseSchema).parse(raw);
  return bases.map((base) => {
    const withNorm = {
      ...base,
      normalizedQuestion: normalizeQuestion(base.labelText),
    };
    const classification = classifyField(withNorm);
    return {
      ...withNorm,
      fieldCategory: classification.category,
      confidence: classification.confidence,
      riskLevel: getRiskLevel(classification.category, classification.confidence),
    };
  });
}

export async function expandComboboxOptions(
  frame: FrameLike,
  fields: DetectedField[],
): Promise<DetectedField[]> {
  const next = [...fields];
  for (let index = 0; index < next.length; index += 1) {
    const field = next[index]!;
    if (field.options.length > 0) continue;
    const looksLikeCombobox =
      field.tagName === "select" || field.inputType === "select";
    if (!looksLikeCombobox) continue;

    try {
      const locator = frame.locator(field.selector).first();
      if (!(await locator.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await locator.click({ timeout: 2_000 });
      const waitMs = 300 + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const optionLocator = frame.locator('[role="option"]');
      const optionCount = await optionLocator.count();
      const options: string[] = [];
      for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
        const option = optionLocator.nth(optionIndex);
        if (!(await option.isVisible({ timeout: 300 }).catch(() => false))) continue;
        const label = (await option.textContent({ timeout: 300 }).catch(() => null))?.trim();
        if (label) options.push(label);
      }
      try {
        await locator.press("Escape", { timeout: 500 });
      } catch {
        // ignore
      }
      if (options.length) {
        next[index] = { ...field, options };
      }
    } catch {
      // Combobox expansion is best-effort.
    }
  }
  return next;
}

function hostAllowed(url: string, allowedHosts: string[]): boolean {
  if (!allowedHosts.length) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedHosts.some(
      (allowed) => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`),
    );
  } catch {
    return url.startsWith("file:");
  }
}

export async function resolveFormRoot(
  page: PageLike,
  allowedHosts: string[],
): Promise<{ frame: FrameLike; isIframe: boolean }> {
  const frames = page.frames();
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    if (frame.isDetached()) continue;
    const url = frame.url();
    if (!hostAllowed(url, allowedHosts) && !url.startsWith("about:")) continue;
    try {
      const controls = frame.locator(
        'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, [contenteditable="true"], [role="combobox"]',
      );
      const count = await controls.count();
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        const visible = await control.isVisible({ timeout: 300 }).catch(() => false);
        const enabled = await control.isEnabled({ timeout: 300 }).catch(() => false);
        if (visible && enabled) return { frame, isIframe: true };
      }
    } catch {
      // Cross-origin or detached frame.
    }
  }

  const main = page.mainFrame();
  return { frame: main, isIframe: false };
}
