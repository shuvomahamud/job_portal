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
import { MAX_APPLICATIONS_PER_RUN } from "../../../src/lib/runLimits";

const payloadSchema = z
  .object({
    jobIds: z.array(z.string().uuid()).min(1).max(MAX_APPLICATIONS_PER_RUN),
    mode: z.enum(["dry_run", "fill_only", "fill_and_submit"]).optional(),
    maxJobs: z.number().int().min(1).max(MAX_APPLICATIONS_PER_RUN).optional(),
    maxRuntimeMinutes: z.number().int().min(1).max(180).optional(),
    /**
     * Set when a human picked this job from the board. The automated cycle only applies
     * to jobs scored "match"; a person choosing a job is the decision, so that gate is
     * skipped. Everything else — active role, resume, daily caps, pause — still applies.
     */
    manual: z.boolean().optional(),
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
  // The caller's number wins; the configured value is the default for callers that
  // omit one. The cycle already applied the user's per-run choice when picking jobIds.
  const runLimit = input.maxJobs ?? cfg.JOB_APPLY_MAX_PER_RUN;
  const maxJobs = Math.min(
    runLimit,
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
  let runStopReason: "run_limit_reached" | "eligible_jobs_exhausted" | "blocked" | "canceled" | "time_limit" =
    "eligible_jobs_exhausted";

  try {
    await addCommandEvent(
      context.command.id,
      "apply_started",
      `Apply started in mode=${mode} for ${jobIds.length} job(s).`,
      { mode, jobIds, maxRuntimeMinutes, maxApplicationsPerRun: runLimit },
    );

    page = await browserSession.context.newPage();

    for (let index = 0; index < jobIds.length; index += 1) {
      const jobId = jobIds[index]!;
      if (context.claimGuard.lost || (await getCommandStatus(context.command.id)) === "canceled") {
        runStopReason = "canceled";
        break;
      }
      if (Date.now() >= deadlineAt) {
        runStopReason = "time_limit";
        break;
      }

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
            location: job.location,
            remoteType: job.remoteType,
            salaryText: job.salaryText,
            employmentType: job.employmentType,
            visaSignal: job.visaSignal,
          },
          mode,
          manual: input.manual ?? false,
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
          runStopReason = "blocked";
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

    if (runStopReason === "eligible_jobs_exhausted" && results.length >= runLimit) {
      runStopReason = "run_limit_reached";
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
      resultJson: {
        mode,
        runLimit,
        attempted: results.length,
        runStopReason,
        summary,
        results,
      },
      message: `Apply run stopped (${runStopReason}) after ${results.length}/${runLimit} job(s): submitted=${summary.submitted} needs_answers=${summary.needsAnswers} blocked=${summary.blocked}.`,
    };
  } finally {
    // A CAPTCHA lives in the page that hit it. Closing that page destroys the only copy
    // of the challenge: the saved URL is a step inside a stateful apply flow, so nobody —
    // not the user, not a later run — can navigate back to it and solve it. Leaving the
    // tab open is what makes "solve it and resume" possible at all.
    // A stall is left open for the same reason as a challenge. The form is usually
    // almost complete when the agent gives up on it, so closing the tab throws away work
    // a person could finish in seconds — and takes with it the only evidence of what
    // actually went wrong.
    const stalled = results.some((result) => result.stopReason === "stalled");
    const leaveOpenForHuman = runStopReason === "blocked" || stalled;
    if (leaveOpenForHuman) {
      logger.info("Leaving the apply browser open for a human", {
        commandId: context.command.id,
        reason: runStopReason,
      });
      await addCommandEvent(
        context.command.id,
        "apply_browser_left_open",
        stalled
          ? "The form could not be advanced automatically. The tab is still open on it, filled in as far as the agent got."
          : "Stopped on a challenge that needs a person. The browser tab is still open on it — solve it there, then resume.",
        { runStopReason, stalled },
      );
    } else {
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
}

export type { ApplyMode };
