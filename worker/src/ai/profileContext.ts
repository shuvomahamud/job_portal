import { createHash } from "node:crypto";
import type { CandidateMatchingContext, JobMatchingContext } from "./matchSchema";

const MAX_ITEM_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 20_000;
const MAX_INSTRUCTIONS_LENGTH = 4_000;
const MAX_JOB_DESCRIPTION_LENGTH = 50_000;
const MAX_RESUME_TEXT_LENGTH = 20_000;

type CandidateProfileRow = {
  targetTitles: string[];
  targetLocations: string[];
  skills: string[];
  preferredEmploymentTypes: string[];
  workAuthorizationAnswer: string | null;
  sponsorshipAnswer: string | null;
  salaryExpectation: string | null;
  summary: string | null;
  dealBreakers: string[];
  matchingInstructions: string | null;
};

type JobRow = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  source: string;
  sourceUrl: string;
  description: string;
  salaryText: string | null;
  employmentType: string | null;
  remoteType: string | null;
  visaSignal: string;
  techStack: string[];
};

function text(value: string | null | undefined, max: number) {
  return value?.replace(/\s+/g, " ").trim().slice(0, max) ?? "";
}

function list(values: string[] | null | undefined) {
  return Array.from(
    new Set((values ?? []).map((value) => text(value, MAX_ITEM_LENGTH)).filter(Boolean)),
  );
}

export type CandidateFactInput = {
  factKey: string;
  factValue: string;
  confidence: number;
  verified: boolean;
};

/**
 * Facts are given to the model as explicit "key: value" lines so experienceFit can be
 * judged from a number rather than re-derived from prose on every job.
 * Unverified low-confidence facts are withheld — the same bar the answer bank uses.
 */
export function formatResumeFacts(
  facts: CandidateFactInput[] | null | undefined,
  minConfidence: number,
): string[] {
  return (facts ?? [])
    .filter((fact) => fact.verified || fact.confidence >= minConfidence)
    .map((fact) => `${fact.factKey}: ${text(fact.factValue, MAX_ITEM_LENGTH)}`)
    .filter((line) => !line.endsWith(": "))
    .sort();
}

export function buildCandidateMatchingContext(
  profile: CandidateProfileRow,
  options?: {
    roleTitle?: string;
    resumeText?: string | null;
    locations?: string[];
    resumeFacts?: string[];
  },
): CandidateMatchingContext {
  const roleTitle = text(options?.roleTitle, MAX_ITEM_LENGTH);
  return {
    resumeFacts: list(options?.resumeFacts),
    targetTitles: roleTitle ? [roleTitle] : list(profile.targetTitles),
    targetLocations: options?.locations?.length
      ? list(options.locations)
      : list(profile.targetLocations),
    skills: list(profile.skills),
    preferredEmploymentTypes: list(profile.preferredEmploymentTypes),
    workAuthorizationAnswer: text(profile.workAuthorizationAnswer, 5_000),
    sponsorshipAnswer: text(profile.sponsorshipAnswer, 5_000),
    salaryExpectation: text(profile.salaryExpectation, 500) || null,
    summary: text(profile.summary, MAX_SUMMARY_LENGTH),
    dealBreakers: list(profile.dealBreakers),
    matchingInstructions: text(profile.matchingInstructions, MAX_INSTRUCTIONS_LENGTH) || null,
    roleTitle,
    resumeText: text(options?.resumeText, MAX_RESUME_TEXT_LENGTH),
  };
}

export function buildJobMatchingContext(job: JobRow, maxDescriptionLength = MAX_JOB_DESCRIPTION_LENGTH): JobMatchingContext {
  return {
    id: job.id,
    title: text(job.title, 300),
    company: text(job.company, 300),
    location: text(job.location, 300) || null,
    source: job.source,
    sourceUrl: text(job.sourceUrl, 2_000),
    description: text(job.description, Math.min(Math.max(1_000, maxDescriptionLength), MAX_JOB_DESCRIPTION_LENGTH)),
    salaryText: text(job.salaryText, 300) || null,
    employmentType: text(job.employmentType, 100) || null,
    remoteType: text(job.remoteType, 100) || null,
    visaSignal: text(job.visaSignal, 100),
    techStack: list(job.techStack),
  };
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function fingerprintCandidate(context: CandidateMatchingContext) {
  return fingerprint(context);
}

export function fingerprintJob(context: JobMatchingContext) {
  return fingerprint(context);
}

export function isMatchingProfileComplete(context: CandidateMatchingContext) {
  return Boolean(
    context.targetTitles.length &&
      context.targetLocations.length &&
      context.workAuthorizationAnswer &&
      context.sponsorshipAnswer &&
      context.summary &&
      (context.skills.length || context.summary.length >= 100),
  );
}
