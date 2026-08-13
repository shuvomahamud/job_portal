import { z } from "zod";

const shortText = z.string().trim().min(1).max(500);

export const jobMatchEvidenceSchema = z
  .object({
    schemaVersion: z.literal("job-match-v1"),
    roleFit: z.enum(["strong", "partial", "weak", "unknown"]),
    skillFit: z.enum(["strong", "partial", "weak", "unknown"]),
    experienceFit: z.enum(["strong", "partial", "weak", "unknown"]),
    authorizationFit: z.enum(["match", "conflict", "unknown"]),
    employmentFit: z.enum(["match", "conflict", "unknown"]),
    locationFit: z.enum(["match", "conflict", "unknown"]),
    confidence: z.enum(["high", "medium", "low"]),
    matchedEvidence: z
      .array(
        z
          .object({
            criterion: z.string().trim().min(1).max(120),
            evidence: shortText,
          })
          .strict(),
      )
      .max(12),
    gaps: z
      .array(
        z
          .object({
            criterion: z.string().trim().min(1).max(120),
            severity: z.enum(["minor", "material", "blocking", "unknown"]),
            evidence: shortText,
          })
          .strict(),
      )
      .max(12),
    hardBlockers: z
      .array(
        z
          .object({
            type: z.enum([
              "authorization",
              "citizenship",
              "clearance",
              "sponsorship",
              "employment_type",
              "location",
              "role",
              "experience",
              "other",
            ]),
            evidence: shortText,
          })
          .strict(),
      )
      .max(8),
    visaNotes: z.string().trim().max(1_000),
    summary: z.string().trim().min(1).max(1_200),
    resumeAngle: z.string().trim().max(1_000).nullable(),
  })
  .strict();

export type JobMatchEvidence = z.infer<typeof jobMatchEvidenceSchema>;

export type CandidateMatchingContext = {
  targetTitles: string[];
  targetLocations: string[];
  skills: string[];
  preferredEmploymentTypes: string[];
  workAuthorizationAnswer: string;
  sponsorshipAnswer: string;
  salaryExpectation: string | null;
  summary: string;
  dealBreakers: string[];
  matchingInstructions: string | null;
  roleTitle: string;
  resumeText: string;
  /** Structured facts read from the resume, as "key: value" lines. */
  resumeFacts: string[];
};

export type JobMatchingContext = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  source: "indeed" | "dice" | string;
  sourceUrl: string;
  description: string;
  salaryText: string | null;
  employmentType: string | null;
  remoteType: string | null;
  visaSignal: string;
  techStack: string[];
};

export type JobMatchInput = {
  candidate: CandidateMatchingContext;
  job: JobMatchingContext;
};

export type JobMatchProvider = {
  readonly providerName: "ollama" | "openai";
  readonly model: string;
  assess(input: JobMatchInput, signal?: AbortSignal): Promise<JobMatchEvidence>;
};

export const jobMatchEvidenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "roleFit",
    "skillFit",
    "experienceFit",
    "authorizationFit",
    "employmentFit",
    "locationFit",
    "confidence",
    "matchedEvidence",
    "gaps",
    "hardBlockers",
    "visaNotes",
    "summary",
    "resumeAngle",
  ],
  properties: {
    schemaVersion: { const: "job-match-v1" },
    roleFit: { enum: ["strong", "partial", "weak", "unknown"] },
    skillFit: { enum: ["strong", "partial", "weak", "unknown"] },
    experienceFit: { enum: ["strong", "partial", "weak", "unknown"] },
    authorizationFit: { enum: ["match", "conflict", "unknown"] },
    employmentFit: { enum: ["match", "conflict", "unknown"] },
    locationFit: { enum: ["match", "conflict", "unknown"] },
    confidence: { enum: ["high", "medium", "low"] },
    matchedEvidence: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "evidence"],
        properties: {
          criterion: { type: "string", minLength: 1, maxLength: 120 },
          evidence: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    gaps: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "severity", "evidence"],
        properties: {
          criterion: { type: "string", minLength: 1, maxLength: 120 },
          severity: { enum: ["minor", "material", "blocking", "unknown"] },
          evidence: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    hardBlockers: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "evidence"],
        properties: {
          type: {
            enum: [
              "authorization",
              "citizenship",
              "clearance",
              "sponsorship",
              "employment_type",
              "location",
              "role",
              "experience",
              "other",
            ],
          },
          evidence: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    visaNotes: { type: "string", maxLength: 1000 },
    summary: { type: "string", minLength: 1, maxLength: 1200 },
    resumeAngle: { type: ["string", "null"], maxLength: 1000 },
  },
} as const;
