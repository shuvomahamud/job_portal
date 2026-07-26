import { z } from "zod";
import { decideJobMatch, type JobMatchDecision } from "../ai/matchPolicy";
import { jobMatchEvidenceSchema, type JobMatchEvidence, type JobMatchProvider } from "../ai/matchSchema";
import { OpenAiJobMatchProvider } from "../ai/openaiReviewClient";
import { OllamaJobMatchProvider } from "../ai/ollamaClient";
import { buildCandidateMatchingContext, buildJobMatchingContext, fingerprintCandidate, fingerprintJob } from "../ai/profileContext";
import { getConfig } from "../config";
import {
  addCommandEvent,
  applyMatchDecision,
  findReusableMatchReview,
  getCandidateProfileById,
  getCommandById,
  getCommandStatus,
  getJobsByIds,
  persistMatchReviewAndDecision,
} from "../db";
import type { HandlerContext, HandlerResult } from "../types";

const payloadSchema = z
  .object({
    parentCommandId: z.uuid(),
    candidateProfileId: z.uuid(),
    jobIds: z.array(z.uuid()).min(1).max(100),
    model: z.string().trim().min(1).max(100).optional(),
    promptVersion: z.literal("job-match-prompt-v1"),
    policyVersion: z.literal("job-match-policy-v1"),
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
      return { evidence: await provider.assess(input), attempt, error: null };
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
}) {
  return {
    schemaVersion: "job-match-v1" as const,
    promptVersion: "job-match-prompt-v1" as const,
    policyVersion: "job-match-policy-v1" as const,
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
  };
}

function cachedEvidence(review: { rawOutput: Record<string, unknown> | null }) {
  const raw = review.rawOutput as { evidence?: unknown; decision?: unknown } | null;
  if (!raw?.evidence || !raw.decision) return null;
  const evidence = jobMatchEvidenceSchema.safeParse(raw.evidence);
  if (!evidence.success) return null;
  return { evidence: evidence.data, decision: decideJobMatch(evidence.data) };
}

export async function handleRunLocalLlmExtraction(payload: unknown, context: HandlerContext): Promise<HandlerResult> {
  const input = payloadSchema.parse(payload);
  const cfg = getConfig();
  const parent = await getCommandById(input.parentCommandId);
  if (!parent || parent.type !== "find_matching_jobs") throw new Error("Local matching command has no valid matching-run parent.");
  if (parent.requestedBy !== context.command.requestedBy) throw new Error("Local matching command ownership does not match its parent.");
  const profile = await getCandidateProfileById(input.candidateProfileId, context.command.requestedBy);
  if (!profile) throw new Error("Matching candidate profile was not found for this command.");

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
  const candidate = buildCandidateMatchingContext(profile);
  const profileFingerprint = fingerprintCandidate(candidate);
  const jobs = await getJobsByIds(input.jobIds);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const matchedJobIds: string[] = [];
  const needsReviewJobIds: string[] = [];
  const archivedJobIds: string[] = [];
  const failedJobIds: string[] = [];
  const warnings: string[] = [];
  let evaluatedCount = 0;
  let remoteReviewCount = 0;

  await addCommandEvent(context.command.id, "local_matching_started", "AI worker started structured profile matching with Ollama.", {
    parentCommandId: input.parentCommandId,
    model: localProvider.model,
    jobCount: input.jobIds.length,
  });

  for (const jobId of input.jobIds) {
    const rootStatus = await getCommandStatus(input.parentCommandId);
    const childStatus = await getCommandStatus(context.command.id);
    if (rootStatus === "canceled" || childStatus === "canceled") {
      warnings.push("Matching stopped because the run was canceled.");
      break;
    }
    const job = byId.get(jobId);
    if (!job) {
      failedJobIds.push(jobId);
      warnings.push(`Job ${jobId} was no longer available for matching.`);
      continue;
    }
    if (["applied", "interview", "offer", "rejected"].includes(job.status)) {
      warnings.push(`${job.title} is already in the application pipeline and was not reclassified.`);
      continue;
    }
    const jobContext = buildJobMatchingContext(job, cfg.AI_MATCH_MAX_JOB_DESCRIPTION_CHARS);
    const jobFingerprint = fingerprintJob(jobContext);
    const startedAt = new Date().toISOString();

    try {
      let localEvidence: JobMatchEvidence;
      let localDecision: JobMatchDecision;
      let localAttempt = 0;
      let finalDecisionPersisted = false;
      const reusableLocal = await findReusableMatchReview({
        jobId,
        provider: "ollama",
        model: localProvider.model,
        profileFingerprint,
        jobFingerprint,
        promptVersion: input.promptVersion,
        policyVersion: input.policyVersion,
      });
      const cachedLocal = reusableLocal ? cachedEvidence(reusableLocal) : null;
      if (cachedLocal) {
        localEvidence = cachedLocal.evidence;
        localDecision = cachedLocal.decision;
      } else {
        const attempt = await assessWithRetry(localProvider, { candidate, job: jobContext }, cfg.AI_MATCH_RETRY_LIMIT);
        localEvidence = attempt.evidence;
        localDecision = decideJobMatch(localEvidence);
        localAttempt = attempt.attempt;
        if (attempt.error) warnings.push(`Local review for ${job.title} was unavailable: ${attempt.error.message}`);
        await persistMatchReviewAndDecision({
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
          }),
        });
        finalDecisionPersisted = true;
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
        });
        const cachedRemote = reusableRemote ? cachedEvidence(reusableRemote) : null;
        if (cachedRemote) {
          finalEvidence = cachedRemote.evidence;
          finalDecision = cachedRemote.decision;
          finalDecisionPersisted = false;
        } else {
          const remoteAttempt = await assessWithRetry(remoteProvider, { candidate, job: jobContext }, 1);
          const remoteDecision = decideJobMatch(remoteAttempt.evidence);
          if (remoteAttempt.error) warnings.push(`Remote review for ${job.title} was unavailable: ${remoteAttempt.error.message}`);
          await persistMatchReviewAndDecision({
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
              evidence: remoteAttempt.evidence,
              decision: remoteDecision,
            }),
          });
          finalEvidence = remoteAttempt.evidence;
          finalDecision = remoteDecision;
          finalDecisionPersisted = true;
        }
      }

      if (!finalDecisionPersisted) {
        await applyMatchDecision(jobId, finalEvidence, finalDecision);
      }

      evaluatedCount += 1;
      if (finalDecision.status === "ready_to_apply") matchedJobIds.push(jobId);
      if (finalDecision.status === "needs_review") needsReviewJobIds.push(jobId);
      if (finalDecision.status === "archived") archivedJobIds.push(jobId);
      await addCommandEvent(context.command.id, "local_matching_progress", `Matched ${evaluatedCount} of ${input.jobIds.length} staged job(s).`, {
        jobId,
        status: finalDecision.status,
        score: finalDecision.score,
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

  return {
    parentCommandId: input.parentCommandId,
    evaluatedCount,
    remoteReviewCount,
    matchedJobIds,
    needsReviewJobIds,
    archivedJobIds,
    failedJobIds,
    warnings,
  };
}
