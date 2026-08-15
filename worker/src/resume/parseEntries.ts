import { normalizeQuestion } from "../formfill/questionNormalizer";
import type { FieldCategory, SavedAnswer } from "../formfill/types";
import { getRiskLevel } from "../formfill/riskPolicy";

export type ResumeEntryKind = "work" | "education";

export type ResumeEntry = {
  kind: ResumeEntryKind;
  title: string;
  organization: string;
  location: string | null;
  start: string | null;
  end: string | null;
};

const DATE_RANGE = /(\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{4}|Present)\s*$/i;
const COMPANY_SUFFIX =
  /\b(llc|inc|ltd|corp|co|gmbh|plc|limited|incorporated|solutions|technologies|services|digital|university|college)\b/i;
const COUNTRY_OR_REGION =
  /^(denmark|bangladesh|united states|usa|us|uk|united kingdom|canada|germany|india|sweden|norway|finland|australia|new york)$/i;
const US_STATE = /^[A-Z]{2}$/;

function clean(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
}

function looksLikePlace(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || COMPANY_SUFFIX.test(trimmed)) return false;
  if (COUNTRY_OR_REGION.test(trimmed) || US_STATE.test(trimmed)) return true;
  if (/^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}$/.test(trimmed)) return true;
  return /^[A-Z][A-Za-z .'-]{2,40}$/.test(trimmed) && !/\d/.test(trimmed);
}

export function splitOrganizationLocation(line: string): {
  organization: string;
  location: string | null;
} {
  const parts = clean(line)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return { organization: clean(line), location: null };

  const last = parts[parts.length - 1]!;
  if (US_STATE.test(last) && parts.length >= 3) {
    const city = parts[parts.length - 2]!;
    if (looksLikePlace(city)) {
      return {
        organization: parts.slice(0, -2).join(", "),
        location: `${city}, ${last}`,
      };
    }
  }
  if (looksLikePlace(last)) {
    return { organization: parts.slice(0, -1).join(", "), location: last };
  }
  return { organization: clean(line), location: null };
}

export function parseLocationParts(location: string): {
  city: string;
  state: string | null;
  country: string | null;
  full: string;
} {
  const full = clean(location);
  const parts = full.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    return { city: parts[0]!, state: parts[1]!, country: parts[2]!, full };
  }
  if (parts.length === 2) {
    const second = parts[1]!;
    if (US_STATE.test(second) || /york|california|jersey/i.test(second)) {
      return { city: parts[0]!, state: second, country: "United States", full };
    }
    return { city: parts[0]!, state: null, country: second, full };
  }
  if (COUNTRY_OR_REGION.test(full) && !/^new york$/i.test(full)) {
    return { city: full, state: null, country: full, full };
  }
  return { city: full, state: null, country: null, full };
}

function isTitleLine(line: string): boolean {
  if (!DATE_RANGE.test(line)) return false;
  if (/^environment:/i.test(line)) return false;
  return true;
}

function splitTitleAndDates(line: string): { title: string; start: string | null; end: string | null } {
  const match = line.match(DATE_RANGE);
  if (!match) return { title: clean(line.replace(/\.+$/, "")), start: null, end: null };
  const title = clean(line.slice(0, match.index)).replace(/\.+$/, "");
  return { title, start: match[1] ?? null, end: match[2] ?? null };
}

/**
 * Reads employer/school lines that follow a dated title. Location is whatever the
 * resume put after the organization name ("FiftyTwo Digital, Denmark"), not the
 * candidate's current mailing address.
 */
export function parseResumeEntries(resumeText: string): ResumeEntry[] {
  const lines = resumeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: ResumeEntry[] = [];
  let kind: ResumeEntryKind = "work";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^education\b/i.test(line)) {
      kind = "education";
      continue;
    }
    if (/^(experience|work experience|employment|professional experience)\b/i.test(line)) {
      kind = "work";
      continue;
    }
    if (!isTitleLine(line)) continue;

    const { title, start, end } = splitTitleAndDates(line);
    if (!title) continue;
    const next = lines[index + 1];
    if (!next || isTitleLine(next) || /^environment:/i.test(next)) {
      entries.push({ kind, title, organization: "", location: null, start, end });
      continue;
    }
    const split = splitOrganizationLocation(next);
    entries.push({
      kind,
      title,
      organization: split.organization,
      location: split.location,
      start,
      end,
    });
    index += 1;
  }
  return entries;
}

export function resumeEntryLocationQuestion(entry: ResumeEntry): string {
  return `Location for ${[entry.title, entry.organization].filter(Boolean).join(" ")}`;
}

export function locationAnswersFromResumeEntries(entries: ResumeEntry[]): SavedAnswer[] {
  const now = new Date().toISOString();
  return entries
    .filter((entry) => entry.location && entry.organization)
    .map((entry) => {
      const originalQuestion = resumeEntryLocationQuestion(entry);
      const normalizedQuestion = normalizeQuestion(originalQuestion);
      return {
        id: `resume-entry:${normalizedQuestion}`,
        normalizedQuestion,
        originalQuestion,
        category: "city" as FieldCategory,
        answerValue: entry.location!,
        answerType: "text" as const,
        sitePattern: "",
        domain: "",
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
        riskLevel: getRiskLevel("city", 0.95),
        notes: "Parsed from resume text.",
        aliases: [],
      };
    });
}

export function matchResumeEntry(
  heading: string,
  entries: ResumeEntry[],
): ResumeEntry | null {
  const needle = normalizeQuestion(heading);
  if (!needle) return null;
  let best: { entry: ResumeEntry; score: number } | null = null;
  for (const entry of entries) {
    const organization = normalizeQuestion(entry.organization);
    const title = normalizeQuestion(entry.title);
    let score = 0;
    if (organization && needle.includes(organization)) score += 3;
    if (title && needle.includes(title)) score += 2;
    if (organization && organization.includes(needle)) score += 1;
    if (score > (best?.score ?? 0)) best = { entry, score };
  }
  if (!best || best.score < 3) return null;
  return best.entry;
}
