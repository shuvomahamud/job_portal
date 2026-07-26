import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { getConfig } from "./config";
import type { NormalizedJobInput } from "./types";
import type { RuleFilterResult } from "./rules/ruleEngine";
import type { JobMatchDecision } from "./ai/matchPolicy";
import type { JobMatchEvidence } from "./ai/matchSchema";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getWorkerDb() {
  if (db) return db;
  db = drizzle(neon(getConfig().DATABASE_URL), { schema });
  return db;
}

export async function upsertJobs(inputs: NormalizedJobInput[]) {
  if (!inputs.length) return [];
  const database = getWorkerDb();
  const rows = [];
  for (const input of inputs) {
    const [job] = await database
      .insert(schema.jobs)
      .values({
        title: input.title,
        company: input.company,
        location: input.location ?? null,
        source: input.source,
        sourceUrl: input.sourceUrl,
        postedDate: input.postedDate ?? null,
        description: input.description,
        salaryText: input.salaryText ?? null,
        employmentType: input.employmentType ?? null,
        remoteType: input.remoteType ?? null,
        status: input.status ?? "new",
        fitScore: input.fitScore ?? null,
        priority: input.priority ?? "normal",
        visaSignal: input.visaSignal ?? "unknown",
        techStack: input.techStack ?? [],
        notes: input.notes ?? null,
      })
      .onConflictDoUpdate({
        target: schema.jobs.sourceUrl,
        set: {
          title: input.title,
          company: input.company,
          location: input.location ?? null,
          source: input.source,
          postedDate: input.postedDate ?? null,
          description: input.description,
          salaryText: input.salaryText ?? null,
          employmentType: input.employmentType ?? null,
          remoteType: input.remoteType ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (job) rows.push(job);
  }
  return rows;
}

export async function getExistingUrls(urls: string[]) {
  if (!urls.length) return new Set<string>();
  const rows = await getWorkerDb()
    .select({ sourceUrl: schema.jobs.sourceUrl })
    .from(schema.jobs)
    .where(inArray(schema.jobs.sourceUrl, urls));
  return new Set(rows.map((row) => row.sourceUrl));
}

export async function addCommandEvent(commandId: string, eventType: string, message: string, metadataJson?: Record<string, unknown>) {
  await getWorkerDb().insert(schema.commandEvents).values({ commandId, eventType, message, metadataJson });
}

export async function getCommandStatus(commandId: string) {
  const [row] = await getWorkerDb()
    .select({ status: schema.commands.status })
    .from(schema.commands)
    .where(eq(schema.commands.id, commandId))
    .limit(1);
  return row?.status ?? null;
}

export async function recoverStaleClaims(maxClaimAgeMinutes = 60) {
  const database = getWorkerDb();
  const result = await database.execute(sql`
    UPDATE commands
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = NOW(), error_message = 'Recovered from stale worker claim.'
    WHERE status = 'claimed'
      AND claimed_at < NOW() - (${maxClaimAgeMinutes} || ' minutes')::interval
    RETURNING id
  `);
  return result.rows.map((row) => String((row as { id: unknown }).id));
}

export async function getJobsForPhase2(limit = 100) {
  return getWorkerDb()
    .select()
    .from(schema.jobs)
    .where(or(eq(schema.jobs.status, "new"), isNull(schema.jobs.fitScore)))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(limit);
}


export async function getJobsForRuleFilter(options: { jobIds?: string[]; limit?: number }) {
  const database = getWorkerDb();
  if (options.jobIds?.length) {
    return database
      .select()
      .from(schema.jobs)
      .where(inArray(schema.jobs.id, options.jobIds))
      .limit(options.jobIds.length);
  }
  return database
    .select()
    .from(schema.jobs)
    .where(
      and(
        or(eq(schema.jobs.status, "new"), eq(schema.jobs.status, "needs_review"), isNull(schema.jobs.fitScore)),
        or(isNull(schema.jobs.fitScore), sql`${schema.jobs.updatedAt} < NOW() - INTERVAL '5 minutes'`),
      ),
    )
    .orderBy(desc(schema.jobs.createdAt))
    .limit(options.limit ?? 100);
}

export async function updateJobAfterRuleFilter(jobId: string, evaluation: RuleFilterResult) {
  const [job] = await getWorkerDb()
    .update(schema.jobs)
    .set({
      status: evaluation.status,
      fitScore: evaluation.score,
      priority: evaluation.priority,
      visaSignal: evaluation.visaSignal,
      techStack: evaluation.techStack,
      salaryText: evaluation.salaryText,
      employmentType: evaluation.employmentType,
      remoteType: evaluation.remoteType,
      notes: evaluation.notes,
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, jobId))
    .returning();
  return job;
}

export async function insertRuleReview(jobId: string, evaluation: RuleFilterResult, ruleset: string) {
  const [review] = await getWorkerDb()
    .insert(schema.jobReviews)
    .values({
      jobId,
      reviewerType: "rule_engine",
      score: evaluation.score,
      recommendation: evaluation.recommendation,
      strengths: evaluation.strengths,
      gaps: evaluation.gaps,
      visaNotes: evaluation.visaNotes,
      resumeAngle: evaluation.resumeAngle,
      rawOutput: {
        ruleset,
        matchedPositiveRules: evaluation.matchedPositiveRules,
        matchedNegativeRules: evaluation.matchedNegativeRules,
        visaSignal: evaluation.visaSignal,
        status: evaluation.status,
        priority: evaluation.priority,
      },
    })
    .returning();
  return review;
}

export async function getCandidateProfileForUser(userId: string) {
  const [profile] = await getWorkerDb()
    .select()
    .from(schema.candidateProfiles)
    .where(eq(schema.candidateProfiles.userId, userId))
    .limit(1);
  return profile ?? null;
}

export async function getCandidateProfileById(profileId: string, userId: string) {
  const [profile] = await getWorkerDb()
    .select()
    .from(schema.candidateProfiles)
    .where(and(eq(schema.candidateProfiles.id, profileId), eq(schema.candidateProfiles.userId, userId)))
    .limit(1);
  return profile ?? null;
}

export async function getJobsByIds(jobIds: string[]) {
  if (!jobIds.length) return [];
  return getWorkerDb().select().from(schema.jobs).where(inArray(schema.jobs.id, jobIds));
}

export async function getCommandById(commandId: string) {
  const [command] = await getWorkerDb()
    .select()
    .from(schema.commands)
    .where(eq(schema.commands.id, commandId))
    .limit(1);
  return command ?? null;
}

export async function createWorkerChildCommand(input: {
  parentCommandId: string;
  type: "run_local_llm_extraction";
  requestedBy: string;
  payloadJson: Record<string, unknown>;
  priority?: "low" | "normal" | "high" | "urgent";
}) {
  const database = getWorkerDb();
  const [command] = await database
    .insert(schema.commands)
    .values({
      parentCommandId: input.parentCommandId,
      type: input.type,
      source: "worker",
      requestedBy: input.requestedBy,
      payloadJson: input.payloadJson,
      priority: input.priority ?? "normal",
      scheduledFor: new Date(),
    })
    .returning();
  if (!command) throw new Error("Could not create child command.");
  await database.insert(schema.commandEvents).values([
    {
      commandId: command.id,
      eventType: "created_by_worker",
      message: `Child ${input.type} command created by worker.`,
      metadataJson: { parentCommandId: input.parentCommandId, requestedBy: input.requestedBy },
    },
    {
      commandId: input.parentCommandId,
      eventType: "matching_queued",
      message: "Local AI matching was queued on the Mac worker.",
      metadataJson: { childCommandId: command.id, type: input.type },
    },
  ]);
  return command;
}

type MatchReviewMetadata = {
  schemaVersion: "job-match-v1";
  promptVersion: "job-match-prompt-v1";
  policyVersion: "job-match-policy-v1";
  provider: "ollama" | "openai";
  model: string;
  profileUpdatedAt: string;
  profileFingerprint: string;
  jobUpdatedAt: string;
  jobFingerprint: string;
  startedAt: string;
  completedAt: string;
  attempt: number;
  providerSucceeded: boolean;
  evidence: JobMatchEvidence;
  decision: JobMatchDecision;
};

export async function findReusableMatchReview(input: {
  jobId: string;
  provider: "ollama" | "openai";
  model: string;
  profileFingerprint: string;
  jobFingerprint: string;
  promptVersion: "job-match-prompt-v1";
  policyVersion: "job-match-policy-v1";
}) {
  const rows = await getWorkerDb()
    .select()
    .from(schema.jobReviews)
    .where(eq(schema.jobReviews.jobId, input.jobId))
    .orderBy(desc(schema.jobReviews.createdAt))
    .limit(30);
  return rows.find((row) => {
    const raw = row.rawOutput as Partial<MatchReviewMetadata> | null;
    return (
      raw?.schemaVersion === "job-match-v1" &&
      raw.provider === input.provider &&
      raw.model === input.model &&
      raw.profileFingerprint === input.profileFingerprint &&
      raw.jobFingerprint === input.jobFingerprint &&
      raw.promptVersion === input.promptVersion &&
      raw.policyVersion === input.policyVersion &&
      raw.providerSucceeded === true
    );
  }) ?? null;
}

export async function persistMatchReviewAndDecision(input: {
  job: typeof schema.jobs.$inferSelect;
  reviewerType: "local_llm" | "codex";
  metadata: MatchReviewMetadata;
}) {
  const database = getWorkerDb();
  return database.transaction(async (tx) => {
    const [review] = await tx
      .insert(schema.jobReviews)
      .values({
        jobId: input.job.id,
        reviewerType: input.reviewerType,
        score: input.metadata.decision.score,
        recommendation: input.metadata.decision.recommendation,
        strengths: input.metadata.evidence.matchedEvidence.map((item) => item.evidence).slice(0, 12),
        gaps: input.metadata.evidence.gaps.map((item) => item.evidence).slice(0, 12),
        visaNotes: input.metadata.evidence.visaNotes,
        resumeAngle: input.metadata.evidence.resumeAngle,
        rawOutput: input.metadata,
      })
      .returning();
    const [job] = await tx
      .update(schema.jobs)
      .set(matchDecisionValues(input.metadata.evidence, input.metadata.decision))
      .where(eq(schema.jobs.id, input.job.id))
      .returning();
    return { review, job };
  });
}

function matchDecisionValues(evidence: JobMatchEvidence, decision: JobMatchDecision) {
  return {
    status: decision.status,
    fitScore: decision.score,
    priority: decision.priority,
    visaSignal: decision.visaSignal,
    notes: `AI match: ${evidence.summary} ${decision.reasons.join(" ")}`.slice(0, 20_000),
    updatedAt: new Date(),
  };
}

export async function applyMatchDecision(
  jobId: string,
  evidence: JobMatchEvidence,
  decision: JobMatchDecision,
) {
  const [job] = await getWorkerDb()
    .update(schema.jobs)
    .set(matchDecisionValues(evidence, decision))
    .where(eq(schema.jobs.id, jobId))
    .returning();
  return job ?? null;
}

export async function archiveJobFromHardFilter(input: {
  job: typeof schema.jobs.$inferSelect;
  score: number;
  reasons: string[];
  visaSignal: string;
}) {
  const database = getWorkerDb();
  return database.transaction(async (tx) => {
    const [review] = await tx
      .insert(schema.jobReviews)
      .values({
        jobId: input.job.id,
        reviewerType: "rule_engine",
        score: input.score,
        recommendation: "reject",
        strengths: [],
        gaps: input.reasons,
        visaNotes: input.reasons.join(" "),
        resumeAngle: "Do not tailor a resume for a hard-conflict posting.",
        rawOutput: { ruleset: "profile-hard-filter-v1", reasons: input.reasons, visaSignal: input.visaSignal },
      })
      .returning();
    const [job] = await tx
      .update(schema.jobs)
      .set({
        status: "archived",
        fitScore: input.score,
        priority: "low",
        visaSignal: input.visaSignal,
        notes: `Hard filter: ${input.reasons.join(" ")}`.slice(0, 20_000),
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, input.job.id))
      .returning();
    return { review, job };
  });
}
