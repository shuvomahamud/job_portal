import { z } from "zod";
import { buildCandidateMatchingContext, isMatchingProfileComplete } from "../ai/profileContext";
import { evaluateProfileHardFilter } from "../ai/hardFilter";
import {
  addCommandEvent,
  createWorkerChildCommand,
  getActiveTargetRolesForUser,
  getCandidateProfileForUser,
  getJobsByIds,
  getResumeVersionForUser,
  getTargetRoleForUser,
  upsertJobRoleMatch,
} from "../db";
import { requireCommandUserId } from "../requireCommandUserId";
import { handleDiscoverJobsBrowser } from "./discoverJobsBrowser";
import type { HandlerContext, HandlerResult } from "../types";

function isResumeHealthyForActivation(resume: {
  blobPathname: string | null;
  resumeTextChars: number | null;
  extractionError: string | null;
  textExtractedAt: Date | string | null;
}) {
  if (!resume.blobPathname) return false;
  if (resume.extractionError) return false;
  if (!resume.textExtractedAt) return false;
  if ((resume.resumeTextChars ?? 0) < 800) return false;
  return true;
}

const payloadSchema = z
  .object({
    sources: z.array(z.enum(["indeed", "dice"])).min(1).max(2).default(["indeed", "dice"]),
    queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
    locations: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
    maxResults: z.number().int().min(1).max(50).default(10),
    targetRoleId: z.uuid().optional(),
  })
  .strict();

type DiscoveryResult = {
  upserted: number;
  jobIds: string[];
  discoveredCount: number;
  duplicateCount?: number;
  sources: Array<"indeed" | "dice">;
  warnings?: string[];
};

export async function handleFindMatchingJobs(payload: unknown, context: HandlerContext): Promise<HandlerResult> {
  const input = payloadSchema.parse(payload);
  const userId = requireCommandUserId(context.command.requestedBy);
  const profile = await getCandidateProfileForUser(userId);
  if (!profile) throw new Error("Complete the candidate profile before finding matching jobs.");

  const roles = input.targetRoleId
    ? [await getTargetRoleForUser(input.targetRoleId, userId)].filter(Boolean)
    : await getActiveTargetRolesForUser(userId);
  if (!roles.length) {
    throw new Error("Create and activate at least one target role with a healthy resume before finding matching jobs.");
  }

  const roleResults = [];

  for (const role of roles) {
    if (!role || context.claimGuard.lost) break;
    if (!role.active) {
      throw new Error("The requested target role is not active.");
    }
    const resume = await getResumeVersionForUser(role.resumeVersionId, userId);
    if (!resume || !isResumeHealthyForActivation(resume)) {
      roleResults.push({
        targetRoleId: role.id,
        title: role.title,
        error: "Role resume is unhealthy; skipping.",
      });
      continue;
    }

    const candidate = buildCandidateMatchingContext(profile, {
      roleTitle: role.title,
      locations: role.locations,
      resumeText: resume.resumeText,
    });
    if (!isMatchingProfileComplete(candidate)) {
      throw new Error(
        "Complete work authorization, sponsorship, and a meaningful skills summary before finding matching jobs.",
      );
    }

    const queries = input.targetRoleId ? input.queries : [role.title];
    const locations = input.targetRoleId ? input.locations : role.locations.length ? role.locations : input.locations;

    await addCommandEvent(
      context.command.id,
      "matching_discovery_started",
      `Finding postings for role ${role.title}.`,
      {
        sources: input.sources,
        queries,
        locations,
        maxResults: input.maxResults,
        candidateProfileId: profile.id,
        targetRoleId: role.id,
        resumeVersionId: resume.id,
      },
    );

    const discovery = (await handleDiscoverJobsBrowser(
      {
        sources: input.sources,
        queries,
        locations,
        maxResults: input.maxResults,
        maxPagesPerSearch: 1,
        maxRuntimeMinutes: 30,
        initialStatus: "reviewing",
      },
      context,
    )) as DiscoveryResult;

    const jobs = await getJobsByIds(discovery.jobIds ?? []);
    const candidateJobIds: string[] = [];
    const rejectedJobIds: string[] = [];

    for (const job of jobs) {
      const hardFilter = evaluateProfileHardFilter(candidate, {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        source: job.source,
        sourceUrl: job.sourceUrl,
        description: job.description,
        salaryText: job.salaryText,
        employmentType: job.employmentType,
        remoteType: job.remoteType,
        visaSignal: job.visaSignal,
        techStack: job.techStack,
      });
      if (!hardFilter.eligible) {
        await upsertJobRoleMatch({
          userId,
          jobId: job.id,
          targetRoleId: role.id,
          resumeVersionId: resume.id,
          status: "reject",
          score: hardFilter.score,
          evidenceJson: { hardFilter: true, reasons: hardFilter.reasons },
          reasons: hardFilter.reasons,
          candidateFingerprint: null,
          jobFingerprint: null,
        });
        rejectedJobIds.push(job.id);
        continue;
      }
      candidateJobIds.push(job.id);
    }

    let matchingCommandId: string | null = null;
    if (candidateJobIds.length) {
      const child = await createWorkerChildCommand({
        parentCommandId: context.command.id,
        type: "run_local_llm_extraction",
        requestedBy: context.command.requestedBy,
        payloadJson: {
          parentCommandId: context.command.id,
          candidateProfileId: profile.id,
          jobIds: candidateJobIds,
          promptVersion: "job-match-prompt-v1",
          policyVersion: "job-match-policy-v1",
          targetRoleId: role.id,
          resumeVersionId: resume.id,
        },
        priority: context.command.priority,
      });
      matchingCommandId = child.id;
    }

    roleResults.push({
      targetRoleId: role.id,
      title: role.title,
      resumeVersionId: resume.id,
      discoveredCount: discovery.discoveredCount,
      candidateJobIds,
      rejectedJobIds,
      matchingCommandId,
      warnings: discovery.warnings ?? [],
    });
  }

  return {
    stage: roleResults.some((result) => result.matchingCommandId) ? "matching_queued" : "completed_without_candidates",
    sources: input.sources,
    roleResults,
  };
}
