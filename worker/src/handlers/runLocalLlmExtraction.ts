import { z } from "zod";
import { decideJobMatch, type JobMatchDecision } from "../ai/matchPolicy";
import { jobMatchEvidenceSchema, type JobMatchEvidence, type JobMatchProvider } from "../ai/matchSchema";
import { OpenAiJobMatchProvider } from "../ai/openaiReviewClient";
import { OllamaJobMatchProvider } from "../ai/ollamaClient";
import {
  buildCandidateMatchingContext,
  buildJobMatchingContext,
  fingerprintCandidate,
  fingerprintJob,
  formatResumeFacts,
} from "../ai/profileContext";
import { getConfig } from "../config";
import { FACT_MIN_CONFIDENCE } from "../resume/extractFacts";
import {
  addCommandEvent,
  findReusableMatchReview,
  getBestEligibleRoleMatches,
  getCandidateFactsForUser,
  getCandidateProfileById,
  getCommandById,
  getCommandStatus,
  getJobsByIds,
  getUnscoredJobIdsForRole,
  getResumeVersionForUser,
  getTargetRoleForUser,
  persistMatchReview,
  upsertJobRoleMatch,
} from "../db";
import { requireCommandUserId } from "../requireCommandUserId";
import { isApplyRunActive } from "../ai/applyPriority";
import { withOllamaLock } from "../ai/ollamaLock";
import { isResumeHealthyForActivation } from "../../../src/lib/resumeHealth";
import type { HandlerContext, HandlerResult } from "../types";
import { MAX_DISCOVERY_RESULTS_PER_COMMAND } from "../../../src/lib/runLimits";

const payloadSchema = z
  .object({
    /** Absent for a sweep, which is not the tail of any one search. */
    parentCommandId: z.uuid().optional(),
    candidateProfileId: z.uuid(),
    /**
     * Absent for a sweep, which resolves its work when it runs rather than when it is
     * queued. That distinction is the point: a sweep queued after ten postings were
     * staged finds forty by the time it starts, and a list fixed up front is exactly how
     * postings ended up stranded and unscored forever.
     */
    jobIds: z.array(z.uuid()).min(1).max(MAX_DISCOVERY_RESULTS_PER_COMMAND).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    promptVersion: z.literal("job-match-prompt-v1"),
    policyVersion: z.literal("job-match-policy-v2"),
    targetRoleId: z.uuid(),
    resumeVersionId: z.uuid(),
    /** Why this sweep was queued. Recorded for the activity log, not used for control. */
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

function unavailableEvidence(message: string): JobMatchEvidence {
  return {
    schemaVersion: "job-match-v1",
    roleFit: "unknown",
    skillFit: "unknown",
    experienceFit: "unknown",
    authorizationFit: "unknown",
    employmentFit: "unknown",
    locationFit: "unknown",
    confidence: "low",
    matchedEvidence: [],
    gaps: [{ criterion: "Local AI review", severity: "unknown", evidence: message }],
    hardBlockers: [],
    visaNotes: "No safe authorization conclusion was possible because the local review did not complete.",
    summary: "Local AI review was unavailable or invalid. This job requires review rather than automatic promotion.",
    resumeAngle: null,
  };
}

async function assessWithRetry(provider: JobMatchProvider, input: Parameters<JobMatchProvider["assess"]>[0], retryLimit: number) {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
    try {
      // Scoring only touches the model when applying is not using it. Giving up rather
      // than queueing keeps a posting from being scored while a real form waits for the
      // same model; the sweep will come back for it.
      const evidence = await withOllamaLock("scoring", () => provider.assess(input));
      if (evidence === null) throw new Error("Ollama is in use by an application; deferring this posting.");
      return { evidence, attempt, error: null };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown AI provider error.");
    }
  }
  return { evidence: unavailableEvidence(lastError?.message ?? "Local AI review failed."), attempt: retryLimit + 1, error: lastError };
}

function reviewMetadata(input: {
  provider: JobMatchProvider;
  profileUpdatedAt: Date;
  profileFingerprint: string;
  jobUpdatedAt: Date;
  jobFingerprint: string;
  startedAt: string;
  attempt: number;
  providerSucceeded: boolean;
  evidence: JobMatchEvidence;
  decision: JobMatchDecision;
  resumeVersionId?: string | null;
}) {
  return {
    schemaVersion: "job-match-v1" as const,
    promptVersion: "job-match-prompt-v1" as const,
    policyVersion: "job-match-policy-v2" as const,
    provider: input.provider.providerName,
    model: input.provider.model,
    profileUpdatedAt: input.profileUpdatedAt.toISOString(),
    profileFingerprint: input.profileFingerprint,
    jobUpdatedAt: input.jobUpdatedAt.toISOString(),
    jobFingerprint: input.jobFingerprint,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    attempt: input.attempt,
    providerSucceeded: input.providerSucceeded,
    evidence: input.evidence,
    decision: input.decision,
    resumeVersionId: input.resumeVersionId ?? null,
  };
}

function cachedEvidence(review: { rawOutput: Record<string, unknown> | null }) {
  const raw = review.rawOutput as { evidence?: unknown; decision?: unknown } | null;
  if (!raw?.evidence || !raw.decision) return null;
  const evidence = jobMatchEvidenceSchema.safeParse(raw.evidence);
  if (!evidence.success) return null;
  return { evidence: evidence.data, decision: decideJobMatch(evidence.data) };
}

function roleMatchStatus(decision: JobMatchDecision): "match" | "uncertain" | "reject" {
  return decision.recommendation;
}

function applyAuthorizedContractPolicy(
  evidence: JobMatchEvidence,
  candidate: {
    sponsorshipAnswer: string;
    matchingInstructions: string | null;
    preferredEmploymentTypes: string[];
  },
  job: { title: string; employmentType: string | null; description: string },
): JobMatchEvidence {
  const candidateText = `${candidate.sponsorshipAnswer} ${candidate.matchingInstructions ?? ""}`.toLowerCase();
  const jobText = `${job.title} ${job.employmentType ?? ""} ${job.description}`.toLowerCase();
  const authorizedContract = candidateText.includes("[authorized-contract-alternative]");
  const acceptsContract = candidate.preferredEmploymentTypes.some((value) =>
    /contract|c2c|w2/i.test(value),
  );
  const isContract = /\bcontract(?:or)?\b|contract-to-hire|contract to hire|\bc2c\b|corp-to-corp|\bw2\b/.test(jobText);
  if (!authorizedContract || !acceptsContract || !isContract) return evidence;

  return {
    ...evidence,
    authorizationFit: "match",
    employmentFit: "match",
    hardBlockers: evidence.hardBlockers.filter(
      (blocker) => !["authorization", "sponsorship", "employment_type"].includes(blocker.type),
    ),
    visaNotes: `${evidence.visaNotes} Candidate policy confirms contractor roles do not require sponsorship.`.trim(),
  };
}

export async function handleRunLocalLlmExtraction(payload: unknown, context: HandlerContext): Promise<HandlerResult> {
  const input = payloadSchema.parse(payload);
  const cfg = getConfig();
  const userId = requireCommandUserId(context.command.requestedBy);
  if (input.parentCommandId) {
    const parent = await getCommandById(input.parentCommandId);
    if (!parent || parent.type !== "find_matching_jobs") throw new Error("Local matching command has no valid matching-run parent.");
    if (parent.requestedBy !== context.command.requestedBy) throw new Error("Local matching command ownership does not match its parent.");
  }
  const profile = await getCandidateProfileById(input.candidateProfileId, context.command.requestedBy);
  if (!profile) throw new Error("Matching candidate profile was not found for this command.");

  const role = await getTargetRoleForUser(input.targetRoleId, userId);
  if (!role) throw new Error("Matching target role was not found for this command.");
  if (!role.active) throw new Error("Matching target role is no longer active.");
  if (input.resumeVersionId !== role.resumeVersionId) {
    throw new Error("Matching resume does not match the target role's configured resume.");
  }
  const resumeVersionId = role.resumeVersionId;
  const resume = await getResumeVersionForUser(resumeVersionId, userId);
  if (!resume?.resumeText || !isResumeHealthyForActivation(resume)) {
    throw new Error("Matching target role does not have healthy extracted resume text.");
  }

  const localProvider = new OllamaJobMatchProvider({
    baseUrl: cfg.OLLAMA_BASE_URL,
    allowedRemoteHosts: cfg.ollamaAllowedRemoteHosts,
    model: input.model ?? cfg.OLLAMA_MODEL,
    requestTimeoutMs: cfg.OLLAMA_REQUEST_TIMEOUT_MS,
    keepAlive: cfg.OLLAMA_KEEP_ALIVE,
  });
  const remoteProvider = cfg.REMOTE_AI_REVIEW_ENABLED && cfg.OPENAI_API_KEY
    ? new OpenAiJobMatchProvider({
        apiKey: cfg.OPENAI_API_KEY,
        model: cfg.OPENAI_REVIEW_MODEL,
        reasoningEffort: cfg.OPENAI_REVIEW_REASONING_EFFORT,
        requestTimeoutMs: cfg.OPENAI_REVIEW_TIMEOUT_MS,
      })
    : null;
  const candidate = buildCandidateMatchingContext(profile, {
    roleTitle: role.title,
    locations: role.locations,
    resumeText: resume.resumeText,
    // Must match what find_matching_jobs used, or the candidate fingerprint changes and
    // every cached match review is needlessly re-run.
    resumeFacts: formatResumeFacts(await getCandidateFactsForUser(userId), FACT_MIN_CONFIDENCE),
  });
  const profileFingerprint = fingerprintCandidate(candidate);
  // A sweep decides what to score now, not when it was queued.
  const jobIds = input.jobIds
    ?? (await getUnscoredJobIdsForRole(userId, role.id, MAX_DISCOVERY_RESULTS_PER_COMMAND));
  if (!jobIds.length) {
    return {
      sweep: true,
      evaluatedCount: 0,
      targetRoleId: role.id,
      message: "Nothing left unscored.",
    };
  }
  const jobs = await getJobsByIds(jobIds);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const matchedJobIds: string[] = [];
  const needsReviewJobIds: string[] = [];
  const archivedJobIds: string[] = [];
  const failedJobIds: string[] = [];
  const warnings: string[] = [];
  let evaluatedCount = 0;
  let remoteReviewCount = 0;

  await addCommandEvent(context.command.id, "local_matching_started", "AI worker started structured profile matching with Ollama.", {
    parentCommandId: input.parentCommandId ?? null,
    model: localProvider.model,
    jobCount: jobIds.length,
    sweep: !input.jobIds,
    targetRoleId: role.id,
    resumeVersionId,
  });

  let yieldedToApply = false;

  for (const jobId of jobIds) {
    if (context.claimGuard.lost) {
      warnings.push("Matching stopped because the worker claim was lost.");
      break;
    }
    const rootStatus = input.parentCommandId
      ? await getCommandStatus(input.parentCommandId)
      : null;
    const childStatus = await getCommandStatus(context.command.id);
    if (rootStatus === "canceled" || childStatus === "canceled") {
      warnings.push("Matching stopped because the run was canceled.");
      break;
    }
    // Applying owns the local model while it is filling a real form. Checked between
    // jobs so a request in flight is never abandoned half-finished; whatever is left
    // unscored is picked up by the next sweep, since a sweep asks the database rather
    // than carrying a list.
    if (await isApplyRunActive(userId)) {
      yieldedToApply = true;
      warnings.push("Paused scoring while an application was in progress.");
      break;
    }
    const job = byId.get(jobId);
    if (!job) {
      failedJobIds.push(jobId);
      warnings.push(`Job ${jobId} was no longer available for matching.`);
      continue;
    }
    const jobContext = buildJobMatchingContext(job, cfg.AI_MATCH_MAX_JOB_DESCRIPTION_CHARS);
    const jobFingerprint = fingerprintJob(jobContext);
    const startedAt = new Date().toISOString();

    try {
      let localEvidence: JobMatchEvidence;
      let localDecision: JobMatchDecision;
      let localAttempt = 0;
      const reusableLocal = await findReusableMatchReview({
        jobId,
        provider: "ollama",
        model: localProvider.model,
        profileFingerprint,
        jobFingerprint,
        promptVersion: input.promptVersion,
        policyVersion: input.policyVersion,
        resumeVersionId,
      });
      const cachedLocal = reusableLocal ? cachedEvidence(reusableLocal) : null;
      if (cachedLocal) {
        localEvidence = applyAuthorizedContractPolicy(cachedLocal.evidence, candidate, jobContext);
        localDecision = decideJobMatch(localEvidence);
      } else {
        const attempt = await assessWithRetry(localProvider, { candidate, job: jobContext }, cfg.AI_MATCH_RETRY_LIMIT);
        localEvidence = applyAuthorizedContractPolicy(attempt.evidence, candidate, jobContext);
        localDecision = decideJobMatch(localEvidence);
        localAttempt = attempt.attempt;
        if (attempt.error) warnings.push(`Local review for ${job.title} was unavailable: ${attempt.error.message}`);
        await persistMatchReview({
          job,
          reviewerType: "local_llm",
          metadata: reviewMetadata({
            provider: localProvider,
            profileUpdatedAt: profile.updatedAt,
            profileFingerprint,
            jobUpdatedAt: job.updatedAt,
            jobFingerprint,
            startedAt,
            attempt: localAttempt,
            providerSucceeded: !attempt.error,
            evidence: localEvidence,
            decision: localDecision,
            resumeVersionId,
          }),
        });
      }

      let finalEvidence = localEvidence;
      let finalDecision = localDecision;
      if (localDecision.recommendation === "uncertain" && remoteProvider && remoteReviewCount < cfg.REMOTE_AI_REVIEW_MAX_PER_RUN) {
        remoteReviewCount += 1;
        const reusableRemote = await findReusableMatchReview({
          jobId,
          provider: "openai",
          model: remoteProvider.model,
          profileFingerprint,
          jobFingerprint,
          promptVersion: input.promptVersion,
          policyVersion: input.policyVersion,
          resumeVersionId,
        });
        const cachedRemote = reusableRemote ? cachedEvidence(reusableRemote) : null;
        if (cachedRemote) {
          finalEvidence = applyAuthorizedContractPolicy(cachedRemote.evidence, candidate, jobContext);
          finalDecision = decideJobMatch(finalEvidence);
        } else {
          const remoteAttempt = await assessWithRetry(remoteProvider, { candidate, job: jobContext }, 1);
          const remoteEvidence = applyAuthorizedContractPolicy(remoteAttempt.evidence, candidate, jobContext);
          const remoteDecision = decideJobMatch(remoteEvidence);
          if (remoteAttempt.error) warnings.push(`Remote review for ${job.title} was unavailable: ${remoteAttempt.error.message}`);
          await persistMatchReview({
            job,
            reviewerType: "codex",
            metadata: reviewMetadata({
              provider: remoteProvider,
              profileUpdatedAt: profile.updatedAt,
              profileFingerprint,
              jobUpdatedAt: job.updatedAt,
              jobFingerprint,
              startedAt,
              attempt: remoteAttempt.attempt,
              providerSucceeded: !remoteAttempt.error,
              evidence: remoteEvidence,
              decision: remoteDecision,
              resumeVersionId,
            }),
          });
          finalEvidence = remoteEvidence;
          finalDecision = remoteDecision;
        }
      }

      await upsertJobRoleMatch({
        userId,
        jobId,
        targetRoleId: role.id,
        resumeVersionId,
        status: roleMatchStatus(finalDecision),
        score: finalDecision.score,
        evidenceJson: { evidence: finalEvidence, decision: finalDecision },
        reasons: finalDecision.reasons,
        candidateFingerprint: profileFingerprint,
        jobFingerprint,
      });

      evaluatedCount += 1;
      if (finalDecision.status === "ready_to_apply") matchedJobIds.push(jobId);
      if (finalDecision.status === "needs_review") needsReviewJobIds.push(jobId);
      if (finalDecision.status === "archived") archivedJobIds.push(jobId);
      await addCommandEvent(context.command.id, "local_matching_progress", `Matched ${evaluatedCount} of ${jobIds.length} staged job(s).`, {
        jobId,
        status: finalDecision.status,
        score: finalDecision.score,
        recommendation: finalDecision.recommendation,
        targetRoleId: role.id,
      });
    } catch (error) {
      failedJobIds.push(jobId);
      const message = error instanceof Error ? error.message : "Unknown job matching error.";
      warnings.push(`Matching ${job.title} failed: ${message}`);
      await addCommandEvent(context.command.id, "local_matching_job_failed", "One staged job failed to match; the batch continued.", {
        jobId,
        error: message,
      });
    }
  }

  const selectedMatches = await getBestEligibleRoleMatches(userId, jobIds);

  return {
    sweep: !input.jobIds,
    yieldedToApply,
    parentCommandId: input.parentCommandId ?? null,
    targetRoleId: role.id,
    resumeVersionId,
    evaluatedCount,
    remoteReviewCount,
    matchedJobIds,
    needsReviewJobIds,
    archivedJobIds,
    failedJobIds,
    selectedMatches: selectedMatches.map((match) => ({
      jobId: match.jobId,
      jobRoleMatchId: match.id,
      targetRoleId: match.targetRoleId,
      resumeVersionId: match.resumeVersionId,
      score: match.score,
    })),
    warnings,
  };
}
