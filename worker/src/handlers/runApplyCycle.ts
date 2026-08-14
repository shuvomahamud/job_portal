import { z } from "zod";
import { and, desc, eq, inArray, notExists, or } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { getConfig } from "../config";
import {
  addCommandEvent,
  createWorkerChildCommand,
  getActiveTargetRolesForUser,
  getCandidateProfileForUser,
  getUnscoredJobIdsForRole,
  getWorkerDb,
} from "../db";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";
import {
  ELIGIBLE_ROLE_MATCH_STATUS,
  isApplyPaused,
  selectJobsWithinRunLimits,
} from "../apply/applyEligibility";
import { discoveryTargetFor } from "../search/discoveryLimits";
import {
  MAX_APPLICATIONS_PER_RUN,
  MAX_DISCOVERY_RESULTS_PER_COMMAND,
} from "../../../src/lib/runLimits";

const payloadSchema = z
  .object({
    phase: z.enum(["discover", "apply"]).optional(),
    maxJobs: z.number().int().min(1).max(MAX_APPLICATIONS_PER_RUN).optional(),
    mode: z.enum(["dry_run", "fill_only", "fill_and_submit"]).optional(),
    /** Job boards to search. Defaults to every supported board. */
    sources: z.array(z.enum(["indeed", "dice"])).min(1).max(2).optional(),
    matchingCommandIds: z.array(z.string().uuid()).max(50).optional(),
    attempt: z.number().int().min(0).max(20).optional(),
    parentCommandId: z.string().uuid().optional(),
  })
  .strict();

const ALL_SOURCES = ["indeed", "dice"] as const;

export async function handleRunApplyCycle(
  payload: unknown,
  context: HandlerContext,
): Promise<HandlerResult> {
  const input = payloadSchema.parse(payload);
  const userId = requireCommandUserId(context.command.requestedBy);
  const phase = input.phase ?? "discover";
  const cfg = getConfig();
  const database = getWorkerDb();
  if (await isApplyPaused(userId)) {
    return { phase, message: "Automated apply is paused for this user." };
  }

  if (phase === "discover") {
    const roles = await getActiveTargetRolesForUser(userId);
    if (!roles.length) {
      return {
        phase,
        matchingCommandIds: [],
        message: "No active target roles; nothing to discover.",
      };
    }

    // The per-run choice is authoritative; the configured value is only the default for
    // a run that did not specify one. Clamping to it made the number chosen on the
    // dashboard a lie — asking for 50 silently became 20.
    const requestedJobs = input.maxJobs ?? cfg.JOB_APPLY_MAX_PER_RUN;
    const maxResults = discoveryTargetFor(requestedJobs);
    const profile = await getCandidateProfileForUser(userId);

    const matchingCommandIds: string[] = [];
    for (const role of roles) {
      if (context.claimGuard.lost) break;
      const child = await createWorkerChildCommand({
        parentCommandId: context.command.id,
        type: "find_matching_jobs",
        requestedBy: userId,
        payloadJson: {
          sources: input.sources ?? [...ALL_SOURCES],
          queries: Array.from(
            new Set([role.title, ...(profile?.targetTitles ?? [])]),
          ).slice(0, 10),
          locations: role.locations.length ? role.locations : ["Remote"],
          maxResults,
          targetRoleId: role.id,
        },
        priority: "normal",
      });
      matchingCommandIds.push(child.id);

      // Catch up on anything a previous run stranded. A search that is interrupted after
      // saving postings but before queueing their scoring leaves them unscored forever —
      // nothing else ever revisits them, and an unscored job can never be applied to.
      if (profile) {
        const stranded = await getUnscoredJobIdsForRole(
          userId,
          role.id,
          MAX_DISCOVERY_RESULTS_PER_COMMAND,
        );
        if (stranded.length) {
          const catchUp = await createWorkerChildCommand({
            parentCommandId: context.command.id,
            type: "run_local_llm_extraction",
            requestedBy: userId,
            payloadJson: {
              parentCommandId: context.command.id,
              candidateProfileId: profile.id,
              jobIds: stranded,
              promptVersion: "job-match-prompt-v1",
              policyVersion: "job-match-policy-v2",
              targetRoleId: role.id,
              resumeVersionId: role.resumeVersionId,
            },
            priority: "normal",
          });
          matchingCommandIds.push(catchUp.id);
          await addCommandEvent(
            context.command.id,
            "apply_cycle_scoring_catch_up",
            `Queued scoring for ${stranded.length} posting(s) an earlier run left unscored.`,
            { targetRoleId: role.id, jobCount: stranded.length, commandId: catchUp.id },
          );
        }
      }
    }

    const applyChild = await createWorkerChildCommand({
      parentCommandId: context.command.id,
      type: "run_apply_cycle",
      requestedBy: userId,
      payloadJson: {
        phase: "apply",
        maxJobs: input.maxJobs ?? cfg.JOB_APPLY_MAX_PER_RUN,
        mode: input.mode ?? cfg.JOB_APPLY_MODE,
        // Carried through so the apply phase only considers jobs from the chosen boards.
        sources: input.sources,
        matchingCommandIds,
        attempt: 0,
        parentCommandId: context.command.id,
      },
      priority: "normal",
      scheduledFor: new Date(Date.now() + 20 * 60 * 1000),
    });

    await addCommandEvent(
      context.command.id,
      "apply_cycle_discover_queued",
      `Queued ${matchingCommandIds.length} matching command(s); apply phase scheduled.`,
      { matchingCommandIds, applyCommandId: applyChild.id },
    );

    return {
      phase,
      matchingCommandIds,
      applyCommandId: applyChild.id,
      message: `Discover phase queued ${matchingCommandIds.length} role match command(s).`,
    };
  }

  const attempt = input.attempt ?? 0;
  const matchingCommandIds = input.matchingCommandIds ?? [];
  if (matchingCommandIds.length && attempt < 6) {
    const children = await database
      .select({ id: schema.commands.id, status: schema.commands.status })
      .from(schema.commands)
      .where(
        or(
          inArray(schema.commands.id, matchingCommandIds),
          and(
            eq(schema.commands.type, "run_local_llm_extraction"),
            inArray(schema.commands.parentCommandId, matchingCommandIds),
          ),
        ),
      );
    const stillRunning = children.some((child) =>
      ["pending", "claimed"].includes(child.status),
    );
    const failed = children.some((child) => child.status === "failed");
    if (failed) {
      return {
        phase,
        jobIds: [],
        message: "Discovery or scoring failed, so this cycle will not apply to stale jobs. Resolve the reported issue and start a new run.",
      };
    }
    if (stillRunning) {
      const retry = await createWorkerChildCommand({
        parentCommandId: input.parentCommandId ?? context.command.id,
        type: "run_apply_cycle",
        requestedBy: userId,
        payloadJson: {
          phase: "apply",
          maxJobs: input.maxJobs,
          mode: input.mode,
          // Must be carried through, or a deferred retry silently widens back to all boards.
          sources: input.sources,
          matchingCommandIds,
          attempt: attempt + 1,
          parentCommandId: input.parentCommandId ?? context.command.id,
        },
        priority: "normal",
        scheduledFor: new Date(Date.now() + 10 * 60 * 1000),
      });
      return {
        phase,
        deferred: true,
        attempt,
        retryCommandId: retry.id,
        message: "Matching children still running; apply phase rescheduled.",
      };
    }
  }

  // Same rule as the discover phase: the run's own number wins, the config is the default.
  const maxApplicationsPerRun = input.maxJobs ?? cfg.JOB_APPLY_MAX_PER_RUN;

  const selectedSources = input.sources ?? [...ALL_SOURCES];

  const eligible = await database
    .select({
      jobId: schema.jobRoleMatches.jobId,
      score: schema.jobRoleMatches.score,
      targetRoleId: schema.jobRoleMatches.targetRoleId,
      source: schema.jobs.source,
    })
    .from(schema.jobRoleMatches)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobRoleMatches.jobId))
    .innerJoin(schema.targetRoles, eq(schema.targetRoles.id, schema.jobRoleMatches.targetRoleId))
    .where(
      and(
        eq(schema.jobRoleMatches.userId, userId),
        eq(schema.jobRoleMatches.status, ELIGIBLE_ROLE_MATCH_STATUS),
        eq(schema.targetRoles.active, true),
        inArray(schema.jobs.source, selectedSources),
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
    .limit(maxApplicationsPerRun * 10);

  const jobIds = selectJobsWithinRunLimits(
    eligible,
    maxApplicationsPerRun,
    selectedSources,
  );

  if (!jobIds.length) {
    return {
      phase,
      jobIds: [],
      message: "No eligible job_role_matches without an application row.",
    };
  }

  const applyCommand = await createWorkerChildCommand({
    parentCommandId: context.command.id,
    type: "apply_to_jobs",
    requestedBy: userId,
    payloadJson: {
      jobIds,
      mode: input.mode ?? cfg.JOB_APPLY_MODE,
      maxJobs: maxApplicationsPerRun,
    },
    priority: "high",
  });

  await addCommandEvent(
    context.command.id,
    "apply_cycle_apply_queued",
    `Queued apply_to_jobs for ${jobIds.length} job(s), with a run limit of ${maxApplicationsPerRun}.`,
    { applyCommandId: applyCommand.id, jobIds, maxApplicationsPerRun },
  );

  return {
    phase,
    jobIds,
    applyCommandId: applyCommand.id,
    message: `Apply phase queued ${jobIds.length} job(s); this run stops after at most ${maxApplicationsPerRun}.`,
  };
}

export async function hasUnfinishedApplyCycle(userId: string): Promise<boolean> {
  const database = getWorkerDb();
  const [row] = await database
    .select({ id: schema.commands.id })
    .from(schema.commands)
    .where(
      and(
        eq(schema.commands.type, "run_apply_cycle"),
        eq(schema.commands.requestedBy, userId),
        inArray(schema.commands.status, ["pending", "claimed"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}
