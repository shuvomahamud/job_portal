import { getRiskLevel } from "./riskPolicy";
import { normalizeQuestion } from "./questionNormalizer";
import type { DetectedField, FieldSuggestion, SavedAnswer } from "./types";

const NONE = "None";

function suggestion(
  field: DetectedField,
  answer: SavedAnswer,
  reason: string,
): FieldSuggestion {
  return {
    field,
    match: {
      fieldId: field.id,
      savedAnswerId: answer.id,
      matchType: "retrieved",
      confidence: 0.96,
      reason,
      requiresReview: false,
    },
    savedAnswer: answer,
    suggestedValue: answer.answerValue,
    source: "retrieved",
    requiresReview: false,
  };
}

function derivedAnswer(
  id: string,
  field: DetectedField,
  value: string,
  notes: string,
): SavedAnswer {
  return {
    id,
    normalizedQuestion: field.normalizedQuestion || normalizeQuestion(field.labelText),
    originalQuestion: field.labelText,
    category: field.fieldCategory,
    answerValue: value,
    answerType: field.inputType === "textarea" ? "textarea" : "text",
    sitePattern: "",
    domain: "",
    usageCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    riskLevel: getRiskLevel(field.fieldCategory, 0.9),
    notes,
    aliases: [],
  };
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mentions(haystack: string, needle: string): boolean {
  const n = compact(needle);
  if (n.length < 3) return false;
  const h = compact(haystack);
  if (h.includes(n)) return true;
  const tokens = n.split(" ").filter((token) => token.length > 2);
  return tokens.length > 0 && tokens.every((token) => h.includes(token));
}

export function isPriorEmployerQuestion(label: string): boolean {
  return (
    /previously (been )?employed|ever (been )?employed|worked (for|with|at) this (company|employer)|former employee|current or former employee|previously worked/i.test(
      label,
    ) || /been employed with\b/i.test(label)
  );
}

export function isEducationCompositeQuestion(label: string): boolean {
  return (
    /\b(trade school|graduate school|high school|university|college)\b/i.test(label) &&
    /\b(city|state|degree)\b/i.test(label)
  );
}

export function educationCompositeKind(
  label: string,
): "trade" | "graduate" | "university" | null {
  if (!isEducationCompositeQuestion(label)) return null;
  if (/\btrade school\b/i.test(label)) return "trade";
  if (/\bgraduate school\b/i.test(label) || /\b(master|mba|ph\.?d)\b/i.test(label)) {
    return "graduate";
  }
  return "university";
}

export function isSkillsOrCertificatesQuestion(label: string): boolean {
  const text = label.toLowerCase();
  const skills = /\b(skills?|certificates?|certifications?|licenses?)\b/.test(text);
  const listing = /\b(list|other|education|possess|related|additional)\b/.test(text);
  return skills && listing;
}

type EducationRecord = {
  key: string;
  kind: "trade" | "graduate" | "university";
  school: string | null;
  location: string | null;
  degree: string | null;
  field: string | null;
};

function educationKindFromKey(key: string): EducationRecord["kind"] {
  if (/\b(trade|vocational|certificate)\b/i.test(key)) return "trade";
  if (/\b(master|mba|ph\.?d|doctorate|graduate)\b/i.test(key)) return "graduate";
  return "university";
}

const EDUCATION_PART =
  /^(school|institution|university|degree|degree type|field of study|major|location|school location) for (.+)$/i;

export function educationRecordsFromAnswers(answers: SavedAnswer[]): EducationRecord[] {
  const groups = new Map<string, EducationRecord>();
  for (const answer of answers) {
    const match = EDUCATION_PART.exec(answer.originalQuestion.trim());
    if (!match) continue;
    const part = match[1]!.toLowerCase();
    const key = match[2]!.trim();
    const current = groups.get(key) ?? {
      key,
      kind: educationKindFromKey(key),
      school: null,
      location: null,
      degree: null,
      field: null,
    };
    const value = answer.answerValue.trim();
    if (!value) {
      groups.set(key, current);
      continue;
    }
    if (part === "school" || part === "institution" || part === "university") current.school = value;
    else if (part === "location" || part === "school location") current.location = value;
    else if (part === "degree" || part === "degree type") current.degree = value;
    else if (part === "field of study" || part === "major") current.field = value;
    groups.set(key, current);
  }
  return [...groups.values()].filter((row) => row.school || row.degree);
}

export function formatEducationRecord(row: EducationRecord): string {
  const degree = [row.degree, row.field].filter(Boolean).join(" in ");
  return [row.school, row.location, degree].filter(Boolean).join(", ");
}

export function knownEmployers(answers: SavedAnswer[]): string[] {
  const names: string[] = [];
  for (const answer of answers) {
    if (
      /^(employer|company|organization) for /i.test(answer.originalQuestion) ||
      answer.category === "current_company"
    ) {
      const value = answer.answerValue.trim();
      if (value) names.push(value);
    }
  }
  return names;
}

function companyFromPriorEmployerQuestion(label: string): string | null {
  const match = label.match(
    /(?:employed with|employed by|worked (?:for|with|at)|worked at)\s+(.+?)\s*\*?$/i,
  );
  const raw = match?.[1]?.replace(/\s*\*$/, "").trim();
  if (!raw || /this (company|employer)/i.test(raw)) return null;
  return raw;
}

function pickSkillsAndEducation(answers: SavedAnswer[]): string | null {
  const skills = answers.find(
    (answer) =>
      /technical skills|primary technical skills|technology stack|core technology/i.test(
        `${answer.originalQuestion} ${answer.normalizedQuestion}`,
      ) || answer.normalizedQuestion === "technical skills",
  );
  const education = answers.find((answer) =>
    /educational background|highest education|what is your educational background/i.test(
      `${answer.originalQuestion} ${answer.normalizedQuestion}`,
    ),
  );
  const parts = [education?.answerValue.trim(), skills?.answerValue.trim()].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * Maps a form question onto answers already in the bank or resume — no invented text.
 * Used when token similarity misses "Have you worked at USALCO?" or "University, City & State, Degree".
 */
export function matchDerivedBankAnswer(
  field: DetectedField,
  answers: SavedAnswer[],
  company: string,
): FieldSuggestion | null {
  const label = field.labelText;

  if (isPriorEmployerQuestion(label)) {
    const named = companyFromPriorEmployerQuestion(label);
    const target = named || company;
    const employers = knownEmployers(answers);
    const workedThere =
      Boolean(target) && employers.some((employer) => mentions(employer, target) || mentions(target, employer));
    const value = workedThere ? "Yes" : "No";
    return suggestion(
      field,
      derivedAnswer(
        `derived:prior-employer:${value.toLowerCase()}`,
        field,
        value,
        workedThere
          ? `Work history includes ${target}.`
          : `${target || "This company"} is not in the saved work history.`,
      ),
      "Prior-employer questions reuse work history from the answer bank.",
    );
  }

  const kind = educationCompositeKind(label);
  if (kind) {
    const records = educationRecordsFromAnswers(answers).filter((row) => row.kind === kind);
    const value = records.length ? records.map(formatEducationRecord).join("; ") : NONE;
    return suggestion(
      field,
      derivedAnswer(`derived:education:${kind}`, field, value, "Composed from saved education answers."),
      "Education city/degree fields reuse school, location, and degree already in the bank.",
    );
  }

  if (isSkillsOrCertificatesQuestion(label)) {
    const value = pickSkillsAndEducation(answers);
    if (!value) return null;
    const existing = answers.find((answer) => answer.answerValue === value);
    return suggestion(
      field,
      existing ?? derivedAnswer("derived:skills-education", field, value, "Combined saved education and skills."),
      "Skills/certificate questions reuse the education and technical-skills answers.",
    );
  }

  return null;
}
