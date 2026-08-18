import type { FrameLike, LocatorLike } from "../browser/playwrightTypes";
import { evaluatePageFunction } from "../formfill/domDetector";
import { matchSavedAnswer } from "../formfill/answerMatcher";
import { normalizeQuestion } from "../formfill/questionNormalizer";
import { getRiskLevel } from "../formfill/riskPolicy";
import type { DetectedField, SavedAnswer } from "../formfill/types";
import {
  matchResumeEntry,
  parseLocationParts,
  type ResumeEntry,
} from "../resume/parseEntries";

export type IncompleteResumeCard = {
  selector: string;
  heading: string;
  section: "work" | "education" | "unknown";
};

const LOCATION_CATEGORIES = new Set(["city", "state", "zip", "address", "country"]);

/**
 * Indeed's "Review your resume details" step hides missing location behind a pencil.
 * The detector only sees ordinary inputs, so those cards look empty and Continue is
 * rejected with nothing to ask.
 */
export function looksLikeResumeDetailsReview(text: string): boolean {
  return /review (your )?resume details|resume details/i.test(text);
}

export function isHistoricalResumeLocationField(field: DetectedField): boolean {
  const context = `${field.labelText} ${field.nearbyText} ${field.normalizedQuestion}`;
  // Indeed's "University, City & State, Degree" is one combined field, not the
  // pencil-edit location on a resume card. Treating it as historical made the
  // filler ignore the education answers already in the bank.
  if (
    /\b(trade school|graduate school|high school|university|college)\b/i.test(field.labelText) &&
    /\b(city|state|degree)\b/i.test(field.labelText) &&
    !/^location for /i.test(field.labelText)
  ) {
    return false;
  }
  const locationLike =
    LOCATION_CATEGORIES.has(field.fieldCategory) || /\blocation\b/i.test(context);
  if (!locationLike) return false;
  return (
    /^location for /i.test(field.labelText) ||
    /\b(work experience|education|university|college|school|employer)\b/i.test(context) ||
    /\bat [A-Z0-9]/i.test(field.labelText)
  );
}

/**
 * Historical city answers must only compete for historical resume fields. Leaving them
 * in the ordinary city candidate set makes a question such as "current city of
 * residence" ambiguous as soon as the user has more than one past employer or school.
 */
export function isHistoricalResumeLocationAnswer(answer: SavedAnswer): boolean {
  if (!["city", "state", "zip", "address", "country"].includes(answer.category)) {
    return false;
  }
  return (
    /^location for\b/i.test(answer.originalQuestion.trim()) ||
    answer.id.startsWith("resume-entry:")
  );
}

/** Experience/education locations may only use these answers — never current residence. */
export function historicalLocationAnswers(answers: SavedAnswer[]): SavedAnswer[] {
  return answers.filter(isHistoricalResumeLocationAnswer);
}

export function withResumeCardContext(
  field: DetectedField,
  card: IncompleteResumeCard,
): DetectedField {
  const heading = card.heading.trim();
  if (!heading) return field;
  const label = field.labelText.toLowerCase().includes(heading.toLowerCase())
    ? field.labelText
    : `${field.labelText} for ${heading}`;
  const locationLike =
    LOCATION_CATEGORIES.has(field.fieldCategory) || /\blocation|city|state|zip/i.test(field.labelText);
  const classified = locationLike
    ? {
        fieldCategory: field.fieldCategory === "unknown" ? ("city" as const) : field.fieldCategory,
      }
    : {};
  return {
    ...field,
    ...classified,
    labelText: label,
    normalizedQuestion: normalizeQuestion(label),
    nearbyText: [field.nearbyText, heading, card.section].filter(Boolean).join(" "),
    required: field.required || locationLike,
  };
}

export function syntheticLocationField(card: IncompleteResumeCard): DetectedField {
  const heading = card.heading.trim() || "resume entry";
  const label = `Location for ${heading}`;
  const category = "city" as const;
  return {
    id: `resume-card-${card.selector}`,
    selector: card.selector,
    tagName: "input",
    inputType: "text",
    labelText: label,
    normalizedQuestion: normalizeQuestion(label),
    placeholder: "",
    ariaLabel: "",
    name: "",
    idAttribute: "",
    required: true,
    options: [],
    currentValue: "",
    nearbyText: `${card.section} ${heading}`,
    fieldCategory: category,
    riskLevel: getRiskLevel(category, 0.9),
    confidence: 0.9,
  };
}

export function pendingAsksFromResumeCards(
  cards: IncompleteResumeCard[],
  answers: SavedAnswer[] = [],
): Array<{ field: DetectedField; reason: string }> {
  return cards.flatMap((card) => {
    const field = syntheticLocationField(card);
    if (trustedResumeCardLocationAnswer(card, answers)) return [];
    return [
      {
        field,
        reason:
          "Indeed reports required details missing on this resume entry, and no trusted saved location exists.",
      },
    ];
  });
}

/**
 * A synthetic resume-card question must still go through the answer bank. Asking again
 * when "Location for Senior Software Engineer FiftyTwo Digital" is already saved is how
 * the portal accumulated a redundant question while the value sat in application_answers.
 */
export function trustedResumeCardLocationAnswer(
  card: IncompleteResumeCard,
  answers: SavedAnswer[],
): SavedAnswer | null {
  const field = syntheticLocationField(card);
  const match = matchSavedAnswer(field, answers);
  const saved = match
    ? answers.find((answer) => answer.id === match.savedAnswerId)
    : undefined;
  if (
    saved &&
    match &&
    ["exact", "normalized", "alias"].includes(match.matchType) &&
    !saved.id.startsWith("profile:")
  ) {
    return saved;
  }

  const heading = normalizeQuestion(card.heading);
  if (!heading) return null;
  const historical = answers.filter(
    (answer) => isHistoricalResumeLocationAnswer(answer) && !answer.id.startsWith("profile:"),
  );
  const overlapping = historical.filter((answer) => {
    const needle = answer.normalizedQuestion.replace(/^location /, "");
    return (
      Boolean(needle) &&
      (answer.normalizedQuestion.includes(heading) || heading.includes(needle))
    );
  });
  return overlapping.length === 1 ? overlapping[0]! : null;
}

export function resolveResumeCardLocation(
  card: IncompleteResumeCard,
  answers: SavedAnswer[],
  entries: ResumeEntry[] = [],
): { value: string; source: "answer" | "resume" } | null {
  const saved = trustedResumeCardLocationAnswer(card, historicalLocationAnswers(answers));
  if (saved?.answerValue.trim()) {
    return { value: saved.answerValue.trim(), source: "answer" };
  }
  const entry = matchResumeEntry(card.heading, entries);
  if (entry?.location?.trim()) {
    return { value: entry.location.trim(), source: "resume" };
  }
  return null;
}

export function locationValueForField(field: DetectedField, location: string): string {
  const parts = parseLocationParts(location);
  if (field.fieldCategory === "state") return parts.state ?? location;
  if (field.fieldCategory === "country") return parts.country ?? location;
  if (field.fieldCategory === "city") return parts.city;
  return parts.full;
}

export async function listIncompleteResumeCards(
  frame: FrameLike,
): Promise<IncompleteResumeCard[]> {
  const raw = await evaluatePageFunction(frame, findIncompleteResumeCardsInPage);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (card): card is IncompleteResumeCard =>
      Boolean(card) &&
      typeof card.selector === "string" &&
      typeof card.heading === "string",
  );
}

export async function clickResumeCardEdit(
  frame: FrameLike,
  card: IncompleteResumeCard,
): Promise<boolean> {
  const locator = frame.locator(card.selector).first();
  if (!(await locator.isVisible({ timeout: 500 }).catch(() => false))) return false;
  await locator.click({ timeout: 5_000 }).catch(() => undefined);
  return true;
}

export async function clickResumeCardSave(frame: FrameLike): Promise<boolean> {
  const locator = frame.getByRole("button", { name: /^(save|done)$/i });
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const label = await accessibleName(item);
    if (/save and close|cancel|delete|remove/i.test(label)) continue;
    await item.click({ timeout: 5_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

async function accessibleName(locator: LocatorLike): Promise<string> {
  const aria = (await locator.getAttribute("aria-label").catch(() => null))?.trim();
  if (aria) return aria;
  return (await locator.innerText().catch(() => "")).trim();
}

/**
 * Serialised into the page. Zero imports, zero closure captures.
 */
export function findIncompleteResumeCardsInPage(): IncompleteResumeCard[] {
  function cssEscape(value: string): string {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
    return value.replace(/["\\]/g, "\\$&");
  }

  function cleanText(value: string | null | undefined, maxLength = 180): string {
    return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function uniqueSelector(element: HTMLElement): string {
    const card = element.closest<HTMLElement>(
      '[data-testid="workExperience-card"], [data-testid="education-card"]',
    );
    const editTestId = element.getAttribute("data-testid");
    if (card && editTestId) {
      const cardTestId = card.getAttribute("data-testid") ?? "";
      const cardId = card.getAttribute("id");
      if (cardId) {
        return `[data-testid="${cssEscape(cardTestId)}"][id="${cssEscape(cardId)}"] [data-testid="${cssEscape(editTestId)}"]`;
      }
    }
    if (element.id) return `#${cssEscape(element.id)}`;
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

  function accessibleName(element: Element): string {
    return cleanText(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent,
      80,
    );
  }

  function rgbChannels(color: string): [number, number, number] | null {
    const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function isReddish(color: string): boolean {
    const rgb = rgbChannels(color);
    if (!rgb) return false;
    const [r, g, b] = rgb;
    return r > 150 && r > g * 1.35 && r > b * 1.35;
  }

  function isWarningIcon(element: Element): boolean {
    const name = `${accessibleName(element)} ${element.getAttribute("class") ?? ""}`;
    if (/error|warning|alert|required|incomplete|missing|invalid/i.test(name)) return true;
    const styled = [element, ...element.querySelectorAll("svg, path, circle, span")];
    for (const node of styled.slice(0, 12)) {
      const style = getComputedStyle(node);
      if (isReddish(style.color) || isReddish(style.fill) || isReddish(style.backgroundColor)) {
        return true;
      }
    }
    return false;
  }

  function looksLikeEdit(element: HTMLElement): boolean {
    const testId = element.getAttribute("data-testid") ?? "";
    if (/-card-edit-btn$/i.test(testId)) return true;
    const name = accessibleName(element);
    if (/delete|remove|trash|close|cancel|add\b/i.test(name)) return false;
    if (/\bedit\b/i.test(name)) return true;
    return false;
  }

  function cardRoot(edit: HTMLElement): HTMLElement {
    // Indeed puts the edit button inside a small title-row wrapper while the employer or
    // school sits in a sibling below it. Walk up to the nearest ancestor that owns that
    // card's `*-card-place`; `parentElement.parentElement` only captured the job title on
    // the live page, producing several indistinguishable "Senior Software Engineer"
    // questions.
    let current = edit.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (
        current.querySelector(
          '[data-testid="workExperience-card-place"], [data-testid="education-card-place"]',
        )
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return (
      edit.closest("li, article, [role='listitem']") ??
      edit.closest("section") ??
      edit.parentElement?.parentElement ??
      edit.parentElement ??
      edit
    );
  }

  function nearestSection(element: HTMLElement): IncompleteResumeCard["section"] {
    const headings = [...document.querySelectorAll<HTMLElement>("h1, h2, h3, [role='heading']")];
    const top = element.getBoundingClientRect().top;
    let best = "";
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= top + 8) {
        best = heading.textContent ?? "";
      }
    }
    if (/education/i.test(best)) return "education";
    if (/work experience|experience|employment/i.test(best)) return "work";
    return "unknown";
  }

  function headingFrom(root: HTMLElement): string {
    const title = root.querySelector<HTMLElement>(
      '[data-testid="workExperience-card-title"], [data-testid="education-card-title"]',
    );
    const place = root.querySelector<HTMLElement>(
      '[data-testid="workExperience-card-place"], [data-testid="education-card-place"]',
    );
    const structured = cleanText(
      [title?.textContent, place?.textContent].filter(Boolean).join(" "),
      160,
    );
    if (structured) return structured;

    const clone = root.cloneNode(true) as HTMLElement;
    for (const extra of clone.querySelectorAll("button, svg, input, textarea, select, [aria-label='Error']")) {
      extra.remove();
    }
    return cleanText(clone.textContent, 160)
      .replace(/\b(edit|delete|remove|add)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function warningBefore(edit: HTMLElement): boolean {
    const parent = edit.parentElement;
    if (parent) {
      const children = [...parent.children];
      const index = children.indexOf(edit);
      for (let i = Math.max(0, index - 3); i < index; i += 1) {
        if (isWarningIcon(children[i]!)) return true;
      }
    }
    let prev = edit.previousElementSibling;
    let hops = 0;
    while (prev && hops < 4) {
      if (isWarningIcon(prev)) return true;
      prev = prev.previousElementSibling;
      hops += 1;
    }
    return false;
  }

  function hasLocationToken(heading: string): boolean {
    return /\b(remote|hybrid|on-?site|united states|new york|, [A-Z]{2}|location)\b/i.test(
      heading,
    );
  }

  function hasStructuredLocation(root: HTMLElement): boolean {
    const location = cleanText(
      root.querySelector<HTMLElement>(
        '[data-testid="workExperience-card-location"], [data-testid="education-card-location"]',
      )?.textContent,
      100,
    );
    if (!location) return false;
    // Indeed renders these placeholders after a rejected Continue. They are evidence of
    // a missing location, not values. A bare real city such as "New York" is valid and
    // must keep the card closed.
    return !/^(city|state|city\s*,?\s*state|location)$/i.test(location);
  }

  const hasResumeCards = Boolean(
    document.querySelector(
      '[data-testid="workExperience-card"], [data-testid="education-card"], [data-testid$="-card-edit-btn"]',
    ),
  );
  const pageText = document.body?.innerText?.slice(0, 20_000) ?? "";
  if (
    !hasResumeCards &&
    !/review (your )?resume details|resume details/i.test(pageText)
  ) {
    return [];
  }

  const edits = [...document.querySelectorAll<HTMLElement>("button, [role='button'], a")].filter(
    (element) => looksLikeEdit(element) && element.getClientRects().length > 0,
  );

  const cards: IncompleteResumeCard[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    const section = nearestSection(edit);
    const warned = warningBefore(edit);
    if (section === "unknown" && !warned) continue;
    const root = cardRoot(edit);
    const heading = headingFrom(root);
    const incomplete =
      warned ||
      (Boolean(heading) && !hasStructuredLocation(root) && !hasLocationToken(heading));
    if (!incomplete) continue;
    const selector = uniqueSelector(edit);
    if (seen.has(selector)) continue;
    seen.add(selector);
    cards.push({ selector, heading, section });
    if (cards.length >= 10) break;
  }
  return cards;
}
