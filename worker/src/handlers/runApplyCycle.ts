import { z } from "zod";
import { and, desc, eq, inArray, notExists, or } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { getConfig } from "../config";
import {
  addCommandEvent,
  createWorkerChildCommand,
  getActiveTargetRolesForUser,
  getWorkerDb,
} from "../db";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";
import {
  ELIGIBLE_ROLE_MATCH_STATUS,
  getRemainingDailyCapacity,
  isApplyPaused,
} from "../apply/applyEligibility";

const payloadSchema = z
  .object({
    phase: z.enum(["discover", "apply"]).optional(),
    maxJobs: z.number().int().min(1).max(50).optional(),
    mode: z.enum(["dry_run", "fill_only", "fill_and_submit"]).optional(),
    matchingCommandIds: z.array(z.string().uuid()).max(50).optional(),
    attempt: z.number().int().min(0).max(20).optional(),
    parentCommandId: z.string().uuid().optional(),
  })
  .strict();

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

    const matchingCommandIds: string[] = [];
    for (const role of roles) {
      if (context.claimGuard.lost) break;
      const child = await createWorkerChildCommand({
        parentCommandId: context.command.id,
        type: "find_matching_jobs",
        requestedBy: userId,
        payloadJson: {
          sources: ["indeed", "dice"],
          queries: [role.title],
          locations: role.locations.length ? role.locations : ["Remote"],
          maxResults: 10,
          targetRoleId: role.id,
        },
        priority: "normal",
      });
      matchingCommandIds.push(child.id);
    }

    const applyChild = await createWorkerChildCommand({
      parentCommandId: context.command.id,
      type: "run_apply_cycle",
      requestedBy: userId,
      payloadJson: {
        phase: "apply",
        maxJobs: input.maxJobs ?? cfg.JOB_APPLY_MAX_JOBS_PER_COMMAND,
        mode: input.mode ?? cfg.JOB_APPLY_MODE,
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
    if (stillRunning) {
      const retry = await createWorkerChildCommand({
        parentCommandId: input.parentCommandId ?? context.command.id,
        type: "run_apply_cycle",
        requestedBy: userId,
        payloadJson: {
          phase: "apply",
          maxJobs: input.maxJobs,
          mode: input.mode,
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

  const maxJobs = Math.min(
    input.maxJobs ?? cfg.JOB_APPLY_MAX_JOBS_PER_COMMAND,
    cfg.JOB_APPLY_MAX_JOBS_PER_COMMAND,
  );

  const eligible = await database
    .select({
      jobId: schema.jobRoleMatches.jobId,
      score: schema.jobRoleMatches.score,
      targetRoleId: schema.jobRoleMatches.targetRoleId,
      roleDailyCap: schema.targetRoles.maxApplicationsPerDay,
    })
    .from(schema.jobRoleMatches)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobRoleMatches.jobId))
    .innerJoin(schema.targetRoles, eq(schema.targetRoles.id, schema.jobRoleMatches.targetRoleId))
    .where(
      and(
        eq(schema.jobRoleMatches.userId, userId),
        eq(schema.jobRoleMatches.status, ELIGIBLE_ROLE_MATCH_STATUS),
        eq(schema.targetRoles.active, true),
        inArray(schema.jobs.source, ["indeed", "dice"]),
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
    .limit(maxJobs * 10);

  const seen = new Set<string>();
  const jobIds: string[] = [];
  const roleRemaining = new Map<string, number>();
  let globalRemaining: number | null = null;
  for (const row of eligible) {
    if (seen.has(row.jobId)) continue;
    if (!roleRemaining.has(row.targetRoleId)) {
      const capacity = await getRemainingDailyCapacity({
        userId,
        targetRoleId: row.targetRoleId,
        globalCap: cfg.JOB_APPLY_MAX_PER_DAY,
        roleCap: row.roleDailyCap,
      });
      globalRemaining ??= capacity.globalRemaining;
      roleRemaining.set(row.targetRoleId, capacity.roleRemaining);
    }
    const remainingForRole = roleRemaining.get(row.targetRoleId) ?? 0;
    if ((globalRemaining ?? 0) <= 0 || remainingForRole <= 0) continue;
    seen.add(row.jobId);
    jobIds.push(row.jobId);
    globalRemaining = (globalRemaining ?? 0) - 1;
    roleRemaining.set(row.targetRoleId, remainingForRole - 1);
    if (jobIds.length >= maxJobs) break;
  }

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
      maxJobs: jobIds.length,
    },
    priority: "high",
  });

  await addCommandEvent(
    context.command.id,
    "apply_cycle_apply_queued",
    `Queued apply_to_jobs for ${jobIds.length} job(s).`,
    { applyCommandId: applyCommand.id, jobIds },
  );

  return {
    phase,
    jobIds,
    applyCommandId: applyCommand.id,
    message: `Apply phase queued ${jobIds.length} job(s).`,
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
