import { z } from "zod";
import { inArray } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { loadPlaywright, openBrowserSession } from "../browser/session";
import type { PageLike } from "../browser/playwrightTypes";
import { getConfig, sleep } from "../config";
import { addCommandEvent, getCommandStatus, getWorkerDb } from "../db";
import { logger } from "../logger";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";
import { applyToJob, type ApplyStopReason } from "../apply/applyRunner";
import { effectiveMode, type ApplyMode } from "../apply/applyPolicy";
import { betweenApplicationsMs } from "../apply/humanInput";
import { resolveNotifyChannel } from "../notify";
import { isApplyPaused } from "../apply/applyEligibility";

const payloadSchema = z
  .object({
    jobIds: z.array(z.string().uuid()).min(1).max(10),
    mode: z.enum(["dry_run", "fill_only", "fill_and_submit"]).optional(),
    maxJobs: z.number().int().min(1).max(10).optional(),
    maxRuntimeMinutes: z.number().int().min(1).max(180).optional(),
  })
  .strict();

export async function handleApplyToJobs(
  payload: unknown,
  context: HandlerContext,
): Promise<HandlerResult> {
  const cfg = getConfig();
  if (!cfg.JOB_APPLY_ENABLED) {
    throw new Error(
      "Job apply is disabled. Set JOB_APPLY_ENABLED=true only on the Mac worker where you are logged in.",
    );
  }

  const input = payloadSchema.parse(payload);
  const userId = requireCommandUserId(context.command.requestedBy);
  if (await isApplyPaused(userId)) {
    return {
      status: "completed",
      resultJson: { paused: true },
      message: "Automated apply is paused for this user.",
    };
  }
  const mode = effectiveMode(input.mode, cfg.JOB_APPLY_MODE);
  const maxJobs = Math.min(
    input.maxJobs ?? cfg.JOB_APPLY_MAX_JOBS_PER_COMMAND,
    cfg.JOB_APPLY_MAX_JOBS_PER_COMMAND,
    input.jobIds.length,
  );
  const maxRuntimeMinutes = Math.min(
    input.maxRuntimeMinutes ?? cfg.JOB_APPLY_MAX_MINUTES_PER_APPLICATION * maxJobs,
    cfg.JOB_APPLY_MAX_MINUTES_PER_APPLICATION * maxJobs,
  );
  const deadlineAt = Date.now() + maxRuntimeMinutes * 60 * 1000;
  const jobIds = input.jobIds.slice(0, maxJobs);

  const database = getWorkerDb();
  const jobs = await database
    .select()
    .from(schema.jobs)
    .where(inArray(schema.jobs.id, jobIds));
  const byId = new Map(jobs.map((job) => [job.id, job]));

  const playwright = await loadPlaywright();
  const browserSession = await openBrowserSession(playwright, cfg);
  let page: PageLike | null = null;

  const summary = {
    submitted: 0,
    filled: 0,
    dryRun: 0,
    needsAnswers: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
  };
  const results: Array<{ jobId: string; stopReason: ApplyStopReason }> = [];

  try {
    await addCommandEvent(
      context.command.id,
      "apply_started",
      `Apply started in mode=${mode} for ${jobIds.length} job(s).`,
      { mode, jobIds, maxRuntimeMinutes },
    );

    page = await browserSession.context.newPage();

    for (let index = 0; index < jobIds.length; index += 1) {
      const jobId = jobIds[index]!;
      if (context.claimGuard.lost || (await getCommandStatus(context.command.id)) === "canceled") {
        break;
      }
      if (Date.now() >= deadlineAt) break;

      const job = byId.get(jobId);
      if (!job) {
        results.push({ jobId, stopReason: "error" });
        summary.failed += 1;
        continue;
      }

      try {
        const result = await applyToJob({
          commandId: context.command.id,
          userId,
          job: {
            id: job.id,
            title: job.title,
            company: job.company,
            source: job.source,
            sourceUrl: job.sourceUrl,
            status: job.status,
          },
          mode,
          page,
          browserContext: browserSession.context,
          deadlineAt: Math.min(
            deadlineAt,
            Date.now() + cfg.JOB_APPLY_MAX_MINUTES_PER_APPLICATION * 60 * 1000,
          ),
        });
        results.push({ jobId, stopReason: result.stopReason });
        if (result.stopReason === "submitted") summary.submitted += 1;
        else if (result.stopReason === "filled_not_submitted") summary.filled += 1;
        else if (result.stopReason === "dry_run") summary.dryRun += 1;
        else if (result.stopReason === "needs_answers") summary.needsAnswers += 1;
        else if (result.stopReason === "blocked") {
          summary.blocked += 1;
          break;
        } else if (
          result.stopReason === "already_applied" ||
          result.stopReason === "external_ats" ||
          result.stopReason === "needs_manual" ||
          result.stopReason === "time_limit"
        ) {
          summary.skipped += 1;
        } else summary.failed += 1;

        await addCommandEvent(
          context.command.id,
          "apply_job_finished",
          `Apply finished for job with stopReason=${result.stopReason}.`,
          {
            jobId,
            stopReason: result.stopReason,
            artifacts: result.artifacts,
          },
        );
      } catch (error) {
        summary.failed += 1;
        results.push({ jobId, stopReason: "error" });
        logger.warn("apply_to_jobs job failed", {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (index < jobIds.length - 1) {
        await sleep(
          betweenApplicationsMs(
            cfg.JOB_APPLY_MIN_GAP_SECONDS,
            cfg.JOB_APPLY_MAX_GAP_SECONDS,
          ),
        );
      }
    }

    const channel = resolveNotifyChannel(cfg);
    await channel.notifyRunSummary({
      applied: summary.submitted,
      needsAnswers: summary.needsAnswers,
      blocked: summary.blocked,
      failed: summary.failed,
    });

    return {
      status: "completed",
      resultJson: { mode, summary, results },
      message: `Apply finished: submitted=${summary.submitted} needs_answers=${summary.needsAnswers} blocked=${summary.blocked}.`,
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (error) {
        logger.warn("Failed to close apply page", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await browserSession.close();
    } catch (error) {
      logger.warn("Failed to close apply browser session", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export type { ApplyMode };
