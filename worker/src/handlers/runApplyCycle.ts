import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { getConfig } from "../config";
import {
  addCommandEvent,
  createWorkerChildCommand,
  getActiveTargetRolesForUser,
  getCandidateProfileForUser,
  getUnscoredJobIdsForRole,
  queueScoringSweepIfIdle,
  getWorkerDb,
} from "../db";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";
import { isApplyPaused } from "../apply/applyEligibility";
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

      // Start the scoring worker off immediately, so it clears whatever earlier runs left
      // unscored while this search is still going rather than after it.
      if (profile) {
        const stranded = await getUnscoredJobIdsForRole(
          userId,
          role.id,
          MAX_DISCOVERY_RESULTS_PER_COMMAND,
        );
        if (stranded.length) {
          const catchUp = await queueScoringSweepIfIdle({
            parentCommandId: context.command.id,
            requestedBy: userId,
            candidateProfileId: profile.id,
            targetRoleId: role.id,
            resumeVersionId: role.resumeVersionId,
            reason: "cycle started",
          });
          if (catchUp) {
            matchingCommandIds.push(catchUp.id);
            await addCommandEvent(
              context.command.id,
              "apply_cycle_scoring_catch_up",
              `Queued a scoring sweep; ${stranded.length} posting(s) are currently unscored.`,
              { targetRoleId: role.id, unscoredNow: stranded.length, commandId: catchUp.id },
            );
          }
        }
      }
    }

    // No apply phase is scheduled any more. Nothing needs to guess when scoring will be
    // done, because the applier is not waiting for a signal — it asks the database what is
    // eligible and unapplied, and a posting scored a moment ago is simply in that answer.
    await addCommandEvent(
      context.command.id,
      "apply_cycle_discover_queued",
      `Queued ${matchingCommandIds.length} search command(s). Scoring and applying follow on their own.`,
      { matchingCommandIds },
    );

    return {
      phase,
      matchingCommandIds,
      message: `Searching. ${matchingCommandIds.length} command(s) queued; scoring and applying continue on their own.`,
    };
  }

  // Everything below the discover phase used to live here: waiting for scoring to
  // finish, deferring, re-checking, then selecting jobs and queueing an apply run. The
  // applier now asks the database directly what is eligible and unapplied, so none of
  // that coordination has anything left to coordinate.
  //
  // The phase is kept, rather than removed from the schema, so apply-phase commands
  // already sitting in the queue when this shipped retire quietly instead of failing
  // validation on a payload the handler no longer understands.
  return {
    phase,
    retired: true,
    message:
      "The apply phase is no longer used; applications are queued by the applier as soon as postings become eligible.",
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
