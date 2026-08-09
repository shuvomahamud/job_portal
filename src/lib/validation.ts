import { z } from "zod";
import {
  APPLICATION_STATUSES,
  APPLY_MODES,
  AUTOMATED_JOB_SOURCES,
  COMMAND_TYPES,
  FOLLOWUP_STATUSES,
  JOB_SOURCES,
  JOB_STATUSES,
  PRIORITIES,
} from "./constants";

const nullableText = z.string().trim().max(20_000).nullable().optional();
const hasHttpProtocol = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
const httpUrl = z
  .url()
  .max(2_000)
  .refine(hasHttpProtocol, {
    message: "Only http and https URLs are allowed.",
  });

export const jobImportSchema = z
  .object({
    title: z.string().trim().min(1).max(300).default("Untitled role"),
    company: z.string().trim().min(1).max(300).default("Unknown company"),
    location: z.string().trim().max(300).nullable().optional(),
    source: z.enum(JOB_SOURCES),
    sourceUrl: httpUrl,
    postedDate: z.coerce.date().nullable().optional(),
    description: z.string().trim().min(1).max(200_000),
    salaryText: z.string().trim().max(300).nullable().optional(),
    employmentType: z.string().trim().max(100).nullable().optional(),
    remoteType: z.string().trim().max(100).nullable().optional(),
    status: z.enum(JOB_STATUSES).default("new"),
    fitScore: z.number().int().min(0).max(100).nullable().optional(),
    priority: z.enum(PRIORITIES).default("normal"),
    visaSignal: z.string().trim().max(100).default("unknown"),
    techStack: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    notes: nullableText,
  })
  .strict();

export const jobUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    company: z.string().trim().min(1).max(300).optional(),
    location: z.string().trim().max(300).nullable().optional(),
    postedDate: z.coerce.date().nullable().optional(),
    description: z.string().trim().min(1).max(200_000).optional(),
    salaryText: z.string().trim().max(300).nullable().optional(),
    employmentType: z.string().trim().max(100).nullable().optional(),
    remoteType: z.string().trim().max(100).nullable().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    fitScore: z.number().int().min(0).max(100).nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    visaSignal: z.string().trim().max(100).optional(),
    techStack: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
    notes: nullableText,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one editable field is required.",
  });

export const jobsQuerySchema = z.object({
  visibility: z.enum(["dashboard", "all"]).default("dashboard"),
  status: z.enum(JOB_STATUSES).optional(),
  source: z.string().trim().max(100).optional(),
  company: z.string().trim().max(300).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  search: z.string().trim().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const automatedSources = z
  .array(z.enum(AUTOMATED_JOB_SOURCES))
  .min(1)
  .max(2)
  .optional();
const jobIds = z.array(z.uuid()).min(1).max(100);

export const commandPayloadSchemas = {
  find_matching_jobs: z
    .object({
      sources: z.array(z.enum(AUTOMATED_JOB_SOURCES)).min(1).max(2).default(["indeed", "dice"]),
      queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
      locations: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
      maxResults: z.number().int().min(1).max(50).default(10),
      targetRoleId: z.uuid().optional(),
    })
    .strict(),
  run_job_search: z
    .object({
      sources: automatedSources,
      queries: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
      locations: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  discover_jobs_browser: z
    .object({
      sources: z.array(z.enum(AUTOMATED_JOB_SOURCES)).min(1).max(2).optional(),
      queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
      locations: z.array(z.string().trim().min(1).max(200)).min(1).max(10).optional(),
      maxResults: z.number().int().min(1).max(100).optional(),
      sourceLimits: z
        .object({
          indeed: z.number().int().min(0).max(100).optional(),
          dice: z.number().int().min(0).max(100).optional(),
        })
        .strict()
        .optional(),
      maxPagesPerSearch: z.number().int().min(1).max(5).optional(),
      maxRuntimeMinutes: z.number().int().min(1).max(30).optional(),
      minDelayMs: z.number().int().min(5000).max(120000).optional(),
      maxDelayMs: z.number().int().min(5000).max(180000).optional(),
      dryRun: z.boolean().optional(),
    })
    .strict(),
  import_jobs: z
    .object({
      source: z.enum(["linkedin", "indeed", "dice", "company_site", "other"]),
      urls: z.array(httpUrl).min(1).max(100),
      batchId: z.uuid().optional(),
    })
    .strict(),
  run_rule_filter: z
    .object({
      jobIds: jobIds.optional(),
      ruleset: z.string().trim().min(1).max(100).default("default"),
      limit: z.number().int().min(1).max(200).default(100).optional(),
    })
    .strict(),
  run_local_llm_extraction: z
    .object({
      parentCommandId: z.uuid(),
      candidateProfileId: z.uuid(),
      jobIds,
      model: z.string().trim().min(1).max(100).optional(),
      promptVersion: z.literal("job-match-prompt-v1"),
      policyVersion: z.literal("job-match-policy-v1"),
      targetRoleId: z.uuid(),
      resumeVersionId: z.uuid(),
    })
    .strict(),
  review_top_jobs: z
    .object({
      limit: z.number().int().min(1).max(50).default(10),
      minimumFitScore: z.number().int().min(0).max(100).optional(),
    })
    .strict(),
  review_job: z
    .object({
      jobId: z.uuid(),
      reviewerType: z.enum(["manual", "rule_engine", "local_llm", "codex"]).default("codex"),
    })
    .strict(),
  draft_answer: z
    .object({
      jobId: z.uuid(),
      questionKey: z.string().trim().min(1).max(150).optional(),
      questionText: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict()
    .refine((value) => value.questionKey || value.questionText, {
      message: "questionKey or questionText is required.",
    }),
  trigger_n8n_summary: z
    .object({
      period: z.enum(["daily", "weekly"]),
      recipient: z.email().optional(),
    })
    .strict(),
  sync_n8n_email_events: z
    .object({
      since: z.iso.datetime().optional(),
    })
    .strict(),
  mark_application_status: z
    .object({
      applicationId: z.uuid(),
      status: z.enum(APPLICATION_STATUSES),
      notes: z.string().trim().max(20_000).optional(),
    })
    .strict(),
  reprocess_job: z
    .object({
      jobId: z.uuid(),
      stages: z
        .array(z.enum(["normalize", "extract", "filter", "review"]))
        .min(1)
        .max(4)
        .optional(),
    })
    .strict(),
  run_apply_cycle: z
    .object({
      phase: z.enum(["discover", "apply"]).optional(),
      maxJobs: z.number().int().min(1).max(50).optional(),
      mode: z.enum(APPLY_MODES).optional(),
      matchingCommandIds: z.array(z.uuid()).max(50).optional(),
      attempt: z.number().int().min(0).max(20).optional(),
      parentCommandId: z.uuid().optional(),
    })
    .strict(),
  apply_to_jobs: z
    .object({
      jobIds: z.array(z.uuid()).min(1).max(10),
      mode: z.enum(APPLY_MODES).optional(),
      maxJobs: z.number().int().min(1).max(10).optional(),
      maxRuntimeMinutes: z.number().int().min(1).max(180).optional(),
    })
    .strict(),
  sync_resume_text: z
    .object({
      resumeVersionIds: z.array(z.uuid()).min(1).max(50).optional(),
    })
    .strict(),
} satisfies Record<(typeof COMMAND_TYPES)[number], z.ZodType>;

export const commandCreateSchema = z
  .object({
    type: z.enum(COMMAND_TYPES),
    payloadJson: z.record(z.string(), z.unknown()).default({}),
    priority: z.enum(PRIORITIES).default("normal"),
    scheduledFor: z.coerce.date().optional(),
  })
  .strict();

export type CommandType = (typeof COMMAND_TYPES)[number];

export function validateCommandPayload(
  type: CommandType,
  payload: Record<string, unknown>,
) {
  assertNoExecutionKeys(payload);
  return commandPayloadSchemas[type].parse(payload) as Record<string, unknown>;
}

function assertNoExecutionKeys(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoExecutionKeys(item, `${path}[${index}]`),
    );
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value)) {
    if (/^(cmd|command|shell|script|executable|argv)$/i.test(key)) {
      throw new z.ZodError([
        {
          code: "custom",
          path: [...path.split("."), key],
          message: `Execution field "${key}" is forbidden.`,
        },
      ]);
    }
    assertNoExecutionKeys(nested, `${path}.${key}`);
  }
}

export const workerClaimSchema = z
  .object({
    workerId: z.string().trim().min(2).max(120),
    commandTypes: z.array(z.enum(COMMAND_TYPES)).min(1).max(20).optional(),
  })
  .strict();

export const workerCompleteSchema = z
  .object({
    commandId: z.uuid(),
    workerId: z.string().trim().min(2).max(120),
    resultJson: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const workerFailSchema = z
  .object({
    commandId: z.uuid(),
    workerId: z.string().trim().min(2).max(120),
    errorMessage: z.string().trim().min(1).max(20_000),
    resultJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const n8nEventSchema = z
  .object({
    eventType: z.string().trim().min(1).max(150),
    payloadJson: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const followupUpdateSchema = z.object({
  status: z.enum(FOLLOWUP_STATUSES),
  notes: z.string().trim().max(20_000).nullable().optional(),
});
