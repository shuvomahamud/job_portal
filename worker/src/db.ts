import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { and, desc, eq, inArray, isNull, notExists, notInArray, or, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { getConfig } from "./config";
import type { NormalizedJobInput, WorkerSpawnableCommandType } from "./types";
import type { RuleFilterResult } from "./rules/ruleEngine";
import type { JobMatchDecision } from "./ai/matchPolicy";
import type { JobMatchEvidence } from "./ai/matchSchema";
import type { ResumeFact } from "./resume/extractFacts";

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

export async function getJobsBySourceUrls(urls: string[]) {
  if (!urls.length) return [];
  return getWorkerDb()
    .select({ id: schema.jobs.id, sourceUrl: schema.jobs.sourceUrl })
    .from(schema.jobs)
    .where(inArray(schema.jobs.sourceUrl, urls));
}

export async function addCommandEvent(commandId: string, eventType: string, message: string, metadataJson?: Record<string, unknown>) {
  await getWorkerDb().insert(schema.commandEvents).values({ commandId, eventType, message, metadataJson });
}

export async function upsertAutomationAlert(input: {
  userId: string;
  commandId: string;
  kind: string;
  site: string;
  message: string;
  pageUrl?: string | null;
  metadataJson?: Record<string, unknown>;
}) {
  const database = getWorkerDb();
  const [existing] = await database
    .select({ id: schema.automationAlerts.id })
    .from(schema.automationAlerts)
    .where(
      and(
        eq(schema.automationAlerts.userId, input.userId),
        eq(schema.automationAlerts.site, input.site),
        eq(schema.automationAlerts.kind, input.kind),
        eq(schema.automationAlerts.status, "open"),
      ),
    )
    .limit(1);
  if (existing) {
    const [alert] = await database
      .update(schema.automationAlerts)
      .set({
        commandId: input.commandId,
        message: input.message,
        pageUrl: input.pageUrl ?? null,
        metadataJson: input.metadataJson ?? {},
        updatedAt: new Date(),
      })
      .where(eq(schema.automationAlerts.id, existing.id))
      .returning();
    return alert!;
  }
  const [alert] = await database
    .insert(schema.automationAlerts)
    .values({
      userId: input.userId,
      commandId: input.commandId,
      kind: input.kind,
      site: input.site,
      message: input.message,
      pageUrl: input.pageUrl ?? null,
      metadataJson: input.metadataJson ?? {},
    })
    .returning();
  return alert!;
}

export async function getAutomationAlertForUser(alertId: string, userId: string) {
  const [alert] = await getWorkerDb()
    .select()
    .from(schema.automationAlerts)
    .where(
      and(
        eq(schema.automationAlerts.id, alertId),
        eq(schema.automationAlerts.userId, userId),
      ),
    )
    .limit(1);
  return alert ?? null;
}

export async function resolveAutomationAlerts(userId: string, sites: string[]) {
  if (!sites.length) return [];
  return getWorkerDb()
    .update(schema.automationAlerts)
    .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.automationAlerts.userId, userId),
        eq(schema.automationAlerts.status, "open"),
        inArray(schema.automationAlerts.site, sites),
      ),
    )
    .returning({ id: schema.automationAlerts.id });
}

export async function getCommandStatus(commandId: string) {
  const [row] = await getWorkerDb()
    .select({ status: schema.commands.status })
    .from(schema.commands)
    .where(eq(schema.commands.id, commandId))
    .limit(1);
  return row?.status ?? null;
}

type DependentApplyPhase = {
  status: string;
  payloadJson: Record<string, unknown>;
  resultJson: Record<string, unknown> | null;
};

export function shouldResumeDependentApplyPhase(
  phase: DependentApplyPhase,
  blockedCommandId: string,
): boolean {
  const matchingCommandIds = phase.payloadJson.matchingCommandIds;
  if (
    phase.payloadJson.phase !== "apply" ||
    !Array.isArray(matchingCommandIds) ||
    !matchingCommandIds.includes(blockedCommandId)
  ) {
    return false;
  }
  if (phase.status === "pending") return true;
  return phase.status === "completed" &&
    String(phase.resultJson?.message ?? "").startsWith("Discovery or scoring failed");
}

/**
 * Put the exact command that raised a browser-intervention alert back on the queue.
 * Reusing its id is important: apply-cycle dependency commands already point at that
 * id, so cloning it would leave the original run permanently attached to a failure.
 */
export async function resumeCommandAfterBrowserIntervention(commandId: string, userId: string) {
  const database = getWorkerDb();
  const [command] = await database
    .update(schema.commands)
    .set({
      status: "pending",
      priority: "high",
      scheduledFor: new Date(),
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      completedAt: null,
      resultJson: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.commands.id, commandId),
        eq(schema.commands.requestedBy, userId),
        inArray(schema.commands.status, ["failed", "completed"]),
        inArray(schema.commands.type, [
          "find_matching_jobs",
          "discover_jobs_browser",
          "apply_to_jobs",
          "verify_submission",
        ]),
      ),
    )
    .returning({
      id: schema.commands.id,
      type: schema.commands.type,
      parentCommandId: schema.commands.parentCommandId,
    });
  if (!command) return null;

  // The apply phase created alongside discovery still points at this command id. It may
  // still be pending, or it may already have completed early after observing the browser
  // failure. Put either form back behind the resumed discovery. If matching is still
  // running when it wakes, the normal apply-cycle handler will defer itself again.
  let dependentApplyPhaseIds: string[] = [];
  if (command.parentCommandId && command.type === "find_matching_jobs") {
    const phases = await database
      .select({
        id: schema.commands.id,
        status: schema.commands.status,
        payloadJson: schema.commands.payloadJson,
        resultJson: schema.commands.resultJson,
      })
      .from(schema.commands)
      .where(
        and(
          eq(schema.commands.parentCommandId, command.parentCommandId),
          eq(schema.commands.type, "run_apply_cycle"),
          inArray(schema.commands.status, ["pending", "completed"]),
        ),
      );
    dependentApplyPhaseIds = phases
      .filter((phase) => shouldResumeDependentApplyPhase(phase, command.id))
      .map((phase) => phase.id);

    if (dependentApplyPhaseIds.length) {
      await database
        .update(schema.commands)
        .set({
          status: "pending",
          scheduledFor: new Date(Date.now() + 20 * 60_000),
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          completedAt: null,
          resultJson: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(inArray(schema.commands.id, dependentApplyPhaseIds));
    }
  }

  await database.insert(schema.commandEvents).values({
    commandId: command.id,
    eventType: "resumed_after_browser_intervention",
    message: "Human verification was durably confirmed; the blocked command was queued to resume.",
    metadataJson: {
      requestedBy: userId,
      dependentApplyPhaseIds,
    },
  });
  return command;
}

export async function recoverStaleClaims(maxClaimAgeMinutes = 60) {
  const database = getWorkerDb();
  const result = await database.execute(sql`
    UPDATE commands
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, updated_at = NOW(), error_message = 'Recovered from stale worker claim.'
    WHERE status = 'claimed'
      AND COALESCE(heartbeat_at, claimed_at) < NOW() - (${maxClaimAgeMinutes} || ' minutes')::interval
    RETURNING id
  `);
  return result.rows.map((row) => String((row as { id: unknown }).id));
}

export async function heartbeatCommand(commandId: string, workerId: string): Promise<boolean> {
  const database = getWorkerDb();
  const result = await database.execute(sql`
    UPDATE commands
    SET heartbeat_at = NOW(), updated_at = NOW()
    WHERE id = ${commandId}
      AND claimed_by = ${workerId}
      AND status = 'claimed'
    RETURNING id
  `);
  return result.rows.length > 0;
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
  type: WorkerSpawnableCommandType;
  requestedBy: string;
  payloadJson: Record<string, unknown>;
  priority?: "low" | "normal" | "high" | "urgent";
  scheduledFor?: Date;
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
      scheduledFor: input.scheduledFor ?? new Date(),
    })
    .returning();
  if (!command) throw new Error("Could not create child command.");
  const queuedEventType =
    input.type === "run_local_llm_extraction" ? "matching_queued" : `${input.type}_queued`;
  await database.insert(schema.commandEvents).values([
    {
      commandId: command.id,
      eventType: "created_by_worker",
      message: `Child ${input.type} command created by worker.`,
      metadataJson: { parentCommandId: input.parentCommandId, requestedBy: input.requestedBy },
    },
    {
      commandId: input.parentCommandId,
      eventType: queuedEventType,
      message: `Child ${input.type} command was queued.`,
      metadataJson: { childCommandId: command.id, type: input.type },
    },
  ]);
  return command;
}

type MatchReviewMetadata = {
  schemaVersion: "job-match-v1";
  promptVersion: "job-match-prompt-v1";
  policyVersion: "job-match-policy-v2";
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
  policyVersion: "job-match-policy-v2";
  resumeVersionId?: string | null;
}) {
  const rows = await getWorkerDb()
    .select()
    .from(schema.jobReviews)
    .where(eq(schema.jobReviews.jobId, input.jobId))
    .orderBy(desc(schema.jobReviews.createdAt))
    .limit(30);
  return rows.find((row) => {
    const raw = row.rawOutput as (Partial<MatchReviewMetadata> & { resumeVersionId?: string | null }) | null;
    const resumeMatches =
      (input.resumeVersionId ?? null) === (raw?.resumeVersionId ?? null);
    return (
      raw?.schemaVersion === "job-match-v1" &&
      raw.provider === input.provider &&
      raw.model === input.model &&
      raw.profileFingerprint === input.profileFingerprint &&
      raw.jobFingerprint === input.jobFingerprint &&
      raw.promptVersion === input.promptVersion &&
      raw.policyVersion === input.policyVersion &&
      raw.providerSucceeded === true &&
      resumeMatches
    );
  }) ?? null;
}

export async function upsertJobRoleMatch(input: {
  userId: string;
  jobId: string;
  targetRoleId: string;
  resumeVersionId: string | null;
  status: "match" | "uncertain" | "reject";
  score: number | null;
  evidenceJson: Record<string, unknown> | null;
  reasons: string[];
  candidateFingerprint: string | null;
  jobFingerprint: string | null;
}) {
  const [row] = await getWorkerDb()
    .insert(schema.jobRoleMatches)
    .values({
      userId: input.userId,
      jobId: input.jobId,
      targetRoleId: input.targetRoleId,
      resumeVersionId: input.resumeVersionId,
      status: input.status,
      score: input.score,
      evidenceJson: input.evidenceJson,
      reasons: input.reasons,
      candidateFingerprint: input.candidateFingerprint,
      jobFingerprint: input.jobFingerprint,
    })
    .onConflictDoUpdate({
      target: [
        schema.jobRoleMatches.userId,
        schema.jobRoleMatches.jobId,
        schema.jobRoleMatches.targetRoleId,
      ],
      set: {
        resumeVersionId: input.resumeVersionId,
        status: input.status,
        score: input.score,
        evidenceJson: input.evidenceJson,
        reasons: input.reasons,
        candidateFingerprint: input.candidateFingerprint,
        jobFingerprint: input.jobFingerprint,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function getActiveTargetRolesForUser(userId: string) {
  return getWorkerDb()
    .select()
    .from(schema.targetRoles)
    .where(and(eq(schema.targetRoles.userId, userId), eq(schema.targetRoles.active, true)));
}

export async function getTargetRoleForUser(roleId: string, userId: string) {
  const [row] = await getWorkerDb()
    .select()
    .from(schema.targetRoles)
    .where(and(eq(schema.targetRoles.id, roleId), eq(schema.targetRoles.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function getResumeVersionForUser(resumeVersionId: string, userId: string) {
  const [row] = await getWorkerDb()
    .select()
    .from(schema.resumeVersions)
    .where(
      and(eq(schema.resumeVersions.id, resumeVersionId), eq(schema.resumeVersions.userId, userId)),
    )
    .limit(1);
  return row ?? null;
}

export async function getCandidateFactsForUser(userId: string) {
  return getWorkerDb()
    .select()
    .from(schema.candidateFacts)
    .where(eq(schema.candidateFacts.userId, userId))
    .orderBy(schema.candidateFacts.factKey);
}

/**
 * Writes freshly extracted facts. A fact the user has verified is never overwritten —
 * re-syncing a resume must not silently undo a correction.
 *
 * Facts the previous resume supported but this one does not are removed, or replacing a
 * resume would leave stale numbers behind that still look valid and would still auto-fill
 * applications. Verified facts and anything the user entered by hand always survive.
 *
 * Returns the keys written and the stale keys dropped.
 */
export async function upsertCandidateFacts(input: {
  userId: string;
  resumeVersionId: string;
  facts: ResumeFact[];
}): Promise<{ written: string[]; pruned: string[] }> {
  // An empty extraction is treated as "the model found nothing", not as "this candidate
  // has no facts". Pruning on an empty result would wipe good data after one bad run.
  if (!input.facts.length) return { written: [], pruned: [] };
  const database = getWorkerDb();
  const now = new Date();
  const written: string[] = [];

  for (const fact of input.facts) {
    const [row] = await database
      .insert(schema.candidateFacts)
      .values({
        userId: input.userId,
        resumeVersionId: input.resumeVersionId,
        factKey: fact.key,
        factValue: fact.value,
        confidence: fact.confidence,
        evidence: fact.evidence,
        source: "resume",
        verified: false,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.candidateFacts.userId, schema.candidateFacts.factKey],
        set: {
          resumeVersionId: input.resumeVersionId,
          factValue: fact.value,
          confidence: fact.confidence,
          evidence: fact.evidence,
          source: "resume",
          updatedAt: now,
        },
        setWhere: eq(schema.candidateFacts.verified, false),
      })
      .returning({ factKey: schema.candidateFacts.factKey });
    if (row) written.push(row.factKey);
  }

  const extractedKeys = input.facts.map((fact) => fact.key);
  const pruned = await database
    .delete(schema.candidateFacts)
    .where(
      and(
        eq(schema.candidateFacts.userId, input.userId),
        // Only machine-read facts. A verified or hand-entered fact is the user's, not
        // this resume's, so it is never dropped.
        eq(schema.candidateFacts.verified, false),
        eq(schema.candidateFacts.source, "resume"),
        notInArray(schema.candidateFacts.factKey, extractedKeys),
      ),
    )
    .returning({ factKey: schema.candidateFacts.factKey });

  return { written, pruned: pruned.map((row) => row.factKey) };
}

export async function persistMatchReview(input: {
  job: typeof schema.jobs.$inferSelect;
  reviewerType: "local_llm" | "codex";
  metadata: MatchReviewMetadata;
}) {
  const [review] = await getWorkerDb()
    .insert(schema.jobReviews)
    .values({
      jobId: input.job.id,
      reviewerType: input.reviewerType,
      score: input.metadata.decision.score,
      recommendation: input.metadata.decision.recommendation,
      strengths: input.metadata.evidence.matchedEvidence
        .map((item) => item.evidence)
        .slice(0, 12),
      gaps: input.metadata.evidence.gaps
        .map((item) => item.evidence)
        .slice(0, 12),
      visaNotes: input.metadata.evidence.visaNotes,
      resumeAngle: input.metadata.evidence.resumeAngle,
      rawOutput: input.metadata,
    })
    .returning();
  return review ?? null;
}

type EligibleRoleMatch = Pick<
  typeof schema.jobRoleMatches.$inferSelect,
  "id" | "jobId" | "targetRoleId" | "resumeVersionId" | "status" | "score"
>;

export function chooseBestEligibleRoleMatch<T extends EligibleRoleMatch>(
  matches: readonly T[],
): T | null {
  return [...matches]
    .filter((match) => match.status === "match" && match.resumeVersionId)
    .sort((left, right) => {
      const scoreDifference = (right.score ?? -1) - (left.score ?? -1);
      if (scoreDifference !== 0) return scoreDifference;
      return left.id.localeCompare(right.id);
    })[0] ?? null;
}

export async function getBestEligibleRoleMatches(
  userId: string,
  jobIds: string[],
) {
  if (!jobIds.length) return [];
  const rows = await getWorkerDb()
    .select()
    .from(schema.jobRoleMatches)
    .where(
      and(
        eq(schema.jobRoleMatches.userId, userId),
        eq(schema.jobRoleMatches.status, "match"),
        inArray(schema.jobRoleMatches.jobId, jobIds),
      ),
    )
    .orderBy(schema.jobRoleMatches.jobId, desc(schema.jobRoleMatches.score));

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const matches = grouped.get(row.jobId) ?? [];
    matches.push(row);
    grouped.set(row.jobId, matches);
  }
  return [...grouped.values()]
    .map(chooseBestEligibleRoleMatch)
    .filter((match): match is NonNullable<typeof match> => Boolean(match));
}

export async function archiveJobFromHardFilter(input: {
  job: typeof schema.jobs.$inferSelect;
  score: number;
  reasons: string[];
  visaSignal: string;
}) {
  const database = getWorkerDb();
  const [reviewRows, jobRows] = await database.batch([
    database
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
      .returning(),
    database
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
      .returning(),
  ]);
  return { review: reviewRows[0], job: jobRows[0] };
}

/**
 * Jobs this role has never been scored against.
 *
 * Scoring is queued by a search command as its final act, so a search that is interrupted
 * after saving postings but before that point strands them: nothing ever comes back for
 * them, and an unscored job can never be applied to. Seventy-eight accumulated in a single
 * evening of interrupted runs.
 *
 * Archived jobs are excluded — they were already judged, just not by this role.
 */
export async function getUnscoredJobIdsForRole(
  userId: string,
  targetRoleId: string,
  limit: number,
): Promise<string[]> {
  const database = getWorkerDb();
  const rows = await database
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        notInArray(schema.jobs.status, ["archived", "applied"]),
        notExists(
          database
            .select({ id: schema.jobRoleMatches.id })
            .from(schema.jobRoleMatches)
            .where(
              and(
                eq(schema.jobRoleMatches.jobId, schema.jobs.id),
                eq(schema.jobRoleMatches.userId, userId),
                eq(schema.jobRoleMatches.targetRoleId, targetRoleId),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(schema.jobs.createdAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Queues a scoring sweep unless one is already waiting or running.
 *
 * Scoring is triggered from several places — the start of a cycle, every batch of newly
 * staged postings, the end of a search — and without this they would pile up, each one
 * re-reading the same unscored jobs.
 *
 * Deliberately a check then an insert rather than a database lock. Two triggers firing at
 * the same instant could still queue two, and that is harmless: one scoring worker runs
 * them in turn, and the second finds nothing left because a sweep asks what is unscored
 * when it starts. The cost of a lock is not worth removing a duplicate that does nothing.
 *
 * Returns the new command, or null when one was already pending.
 */
export async function queueScoringSweepIfIdle(input: {
  /** Null when nothing spawned this — a worker noticed unscored postings on its own. */
  parentCommandId: string | null;
  requestedBy: string;
  candidateProfileId: string;
  targetRoleId: string;
  resumeVersionId: string;
  reason: string;
}) {
  const database = getWorkerDb();
  const [existing] = await database
    .select({ id: schema.commands.id })
    .from(schema.commands)
    .where(
      and(
        eq(schema.commands.type, "run_local_llm_extraction"),
        eq(schema.commands.requestedBy, input.requestedBy),
        inArray(schema.commands.status, ["pending", "claimed"]),
      ),
    )
    .limit(1);
  if (existing) return null;

  const payloadJson = {
    // No jobIds and no parentCommandId: this is a sweep, and it decides what to score
    // when it runs rather than inheriting a list fixed at queue time.
    candidateProfileId: input.candidateProfileId,
    promptVersion: "job-match-prompt-v1",
    policyVersion: "job-match-policy-v2",
    targetRoleId: input.targetRoleId,
    resumeVersionId: input.resumeVersionId,
    reason: input.reason,
  };

  // A worker that noticed unscored postings on its own has no parent to hang this from.
  if (!input.parentCommandId) {
    const [command] = await database
      .insert(schema.commands)
      .values({
        type: "run_local_llm_extraction",
        source: "worker",
        requestedBy: input.requestedBy,
        payloadJson,
        priority: "normal",
      })
      .returning();
    return command ?? null;
  }

  return createWorkerChildCommand({
    parentCommandId: input.parentCommandId,
    type: "run_local_llm_extraction",
    requestedBy: input.requestedBy,
    payloadJson: {
      candidateProfileId: input.candidateProfileId,
      promptVersion: "job-match-prompt-v1",
      policyVersion: "job-match-policy-v2",
      targetRoleId: input.targetRoleId,
      resumeVersionId: input.resumeVersionId,
      reason: input.reason,
    },
    priority: "normal",
  });
}

/**
 * Postings that are scored well enough to apply to and have no application row yet.
 *
 * This is the applier's whole input. It is deliberately a question about current state
 * rather than a list handed over by a previous phase, so the applier resumes correctly
 * after any interruption and can never work from a stale set.
 *
 * The set is naturally bounded — it only grows when a search finds something that then
 * scores well — which is why the applier needs no run target to stop it. It drains and
 * goes idle.
 */
export async function getEligibleUnappliedJobIds(
  userId: string,
  limit: number,
): Promise<string[]> {
  const database = getWorkerDb();
  const rows = await database
    .select({ jobId: schema.jobRoleMatches.jobId })
    .from(schema.jobRoleMatches)
    .innerJoin(schema.targetRoles, eq(schema.targetRoles.id, schema.jobRoleMatches.targetRoleId))
    .where(
      and(
        eq(schema.jobRoleMatches.userId, userId),
        eq(schema.jobRoleMatches.status, "match"),
        eq(schema.targetRoles.active, true),
        notExists(
          database
            .select({ id: schema.applications.id })
            .from(schema.applications)
            .where(
              and(
                eq(schema.applications.jobId, schema.jobRoleMatches.jobId),
                eq(schema.applications.userId, userId),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(schema.jobRoleMatches.score))
    .limit(limit);
  return rows.map((row) => row.jobId);
}

/** Queues an apply run unless one is already waiting or running. */
export async function queueApplyRunIfIdle(input: {
  requestedBy: string;
  jobIds: string[];
  mode: string;
}) {
  if (!input.jobIds.length) return null;
  const database = getWorkerDb();
  const [existing] = await database
    .select({ id: schema.commands.id })
    .from(schema.commands)
    .where(
      and(
        eq(schema.commands.type, "apply_to_jobs"),
        eq(schema.commands.requestedBy, input.requestedBy),
        inArray(schema.commands.status, ["pending", "claimed"]),
      ),
    )
    .limit(1);
  if (existing) return null;

  const [command] = await database
    .insert(schema.commands)
    .values({
      type: "apply_to_jobs",
      source: "worker",
      requestedBy: input.requestedBy,
      payloadJson: { jobIds: input.jobIds, mode: input.mode, maxJobs: input.jobIds.length },
      priority: "normal",
    })
    .returning();
  return command ?? null;
}

/**
 * True when something is waiting on the user — a CAPTCHA, a login, a blocked browser.
 *
 * The self-driving applier has to consult this or it spins: an apply run stops on a
 * challenge, the worker goes idle, sees the same eligible postings still unapplied, and
 * queues another run straight back into the same wall. Every ten seconds, with a
 * notification each time.
 *
 * "Ask for help and wait" is only actually waiting if something stops the retry.
 */
export async function hasOpenBlockerAlert(userId: string): Promise<boolean> {
  const [row] = await getWorkerDb()
    .select({ id: schema.automationAlerts.id })
    .from(schema.automationAlerts)
    .where(
      and(
        eq(schema.automationAlerts.userId, userId),
        eq(schema.automationAlerts.status, "open"),
      ),
    )
    .limit(1);
  return Boolean(row);
}
