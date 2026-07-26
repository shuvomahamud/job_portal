import { z } from "zod";
import { buildCandidateMatchingContext, isMatchingProfileComplete } from "../ai/profileContext";
import { evaluateProfileHardFilter } from "../ai/hardFilter";
import { addCommandEvent, archiveJobFromHardFilter, createWorkerChildCommand, getCandidateProfileForUser, getJobsByIds } from "../db";
import { handleDiscoverJobsBrowser } from "./discoverJobsBrowser";
import type { HandlerContext, HandlerResult } from "../types";

const payloadSchema = z
  .object({
    sources: z.array(z.enum(["indeed", "dice"])).min(1).max(2).default(["indeed", "dice"]),
    queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
    locations: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
    maxResults: z.number().int().min(1).max(50).default(10),
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
  const profile = await getCandidateProfileForUser(context.command.requestedBy);
  if (!profile) throw new Error("Complete the candidate profile before finding matching jobs.");
  const candidate = buildCandidateMatchingContext(profile);
  if (!isMatchingProfileComplete(candidate)) {
    throw new Error("Complete target roles, locations, work authorization, sponsorship, and a meaningful skills summary before finding matching jobs.");
  }

  await addCommandEvent(context.command.id, "matching_discovery_started", "Finding individual Indeed/Dice postings for the saved candidate profile.", {
    sources: input.sources,
    queries: input.queries,
    locations: input.locations,
    maxResults: input.maxResults,
    candidateProfileId: profile.id,
  });

  const discovery = (await handleDiscoverJobsBrowser(
    {
      sources: input.sources,
      queries: input.queries,
      locations: input.locations,
      maxResults: input.maxResults,
      maxPagesPerSearch: 1,
      maxRuntimeMinutes: 30,
      initialStatus: "reviewing",
    },
    context,
  )) as DiscoveryResult;
  const jobs = await getJobsByIds(discovery.jobIds ?? []);
  const candidateJobIds: string[] = [];
  const archivedJobIds: string[] = [];
  const preservedPipelineJobIds: string[] = [];

  for (const job of jobs) {
    if (["applied", "interview", "offer", "rejected"].includes(job.status)) {
      preservedPipelineJobIds.push(job.id);
      continue;
    }
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
      await archiveJobFromHardFilter({
        job,
        score: hardFilter.score,
        visaSignal: hardFilter.visaSignal,
        reasons: hardFilter.reasons,
      });
      archivedJobIds.push(job.id);
      continue;
    }
    candidateJobIds.push(job.id);
  }

  if (!candidateJobIds.length) {
    await addCommandEvent(context.command.id, "matching_completed_without_candidates", "No valid jobs remained after the deterministic hard filter.", {
      discoveredCount: discovery.discoveredCount,
      archivedCount: archivedJobIds.length,
    });
    return {
      stage: "completed_without_candidates",
      sources: input.sources,
      queries: input.queries,
      locations: input.locations,
      discoveredCount: discovery.discoveredCount,
      duplicateCount: discovery.duplicateCount ?? Math.max(0, discovery.discoveredCount - jobs.length),
      hardFilteredCount: archivedJobIds.length,
      candidateJobIds,
      archivedJobIds,
      preservedPipelineJobIds,
      matchingCommandId: null,
      warnings: discovery.warnings ?? [],
    };
  }

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
    },
    priority: context.command.priority,
  });

  return {
    stage: "matching_queued",
    sources: input.sources,
    queries: input.queries,
    locations: input.locations,
    discoveredCount: discovery.discoveredCount,
    duplicateCount: discovery.duplicateCount ?? Math.max(0, discovery.discoveredCount - jobs.length),
    hardFilteredCount: archivedJobIds.length,
    candidateJobIds,
    archivedJobIds,
    preservedPipelineJobIds,
    matchingCommandId: child.id,
    warnings: discovery.warnings ?? [],
  };
}
