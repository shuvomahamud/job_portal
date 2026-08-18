import { z } from "zod";
import { inArray } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { loadPlaywright, openBrowserSession } from "../browser/session";
import type { PageLike } from "../browser/playwrightTypes";
import { getConfig, sleep } from "../config";
import { addCommandEvent, getWorkerDb } from "../db";
import { applyShouldHalt } from "../workerAbort";
import { logger } from "../logger";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";
import { applyToJob, type ApplyStopReason } from "../apply/applyRunner";
import { effectiveMode, type ApplyMode } from "../apply/applyPolicy";
import { betweenApplicationsMs } from "../apply/humanInput";
import { resolveNotifyChannel } from "../notify";
import { isApplyPaused } from "../apply/applyEligibility";
import { MAX_APPLICATIONS_PER_RUN } from "../../../src/lib/runLimits";

/**
 * The message a completed run reports.
 *
 * With one job per command — every caller now sends exactly one — that job's own
 * stopReason is the whole story, and is far more useful than a batch label that was never
 * really about it. The batch-summary form is kept for the case of more than one, which
 * nothing currently sends but the payload schema still permits.
 */
export function shouldLeaveApplyBrowserOpen(
  results: Array<{ stopReason: ApplyStopReason }>,
  runStopReason: string,
): boolean {
  if (runStopReason === "blocked") return true;
  return results.some((result) =>
    [
      "blocked",
      "stalled",
      "needs_manual",
      "needs_answers",
      "canceled",
      "time_limit",
      "error",
      "already_applied",
    ].includes(result.stopReason),
  );
}

export function describeApplyRunOutcome(
  results: Array<{ stopReason: ApplyStopReason }>,
  runStopReason: string,
  runLimit: number,
  summary: { submitted: number; needsAnswers: number; blocked: number },
): string {
  if (results.length === 1) {
    return `Apply finished for 1 job: ${results[0]!.stopReason}.`;
  }
  return `Apply run stopped (${runStopReason}) after ${results.length}/${runLimit} job(s): submitted=${summary.submitted} needs_answers=${summary.needsAnswers} blocked=${summary.blocked}.`;
}

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
    stalled: 0,
    needsManual: 0,
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
      if (context.claimGuard.lost || (await applyShouldHalt(context.command.id))) {
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
        } else if (result.stopReason === "stalled") {
          summary.stalled += 1;
        } else if (result.stopReason === "needs_manual") {
          summary.needsManual += 1;
        } else if (
          result.stopReason === "already_applied" ||
          result.stopReason === "external_ats" ||
          result.stopReason === "time_limit"
        ) {
          summary.skipped += 1;
        } else summary.failed += 1;

        if (result.stopReason === "stalled" || result.stopReason === "needs_manual") {
          await resolveNotifyChannel(cfg).notifyStuck({
            jobTitle: job.title,
            company: job.company,
            kind: result.stopReason,
          });
        }

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

    // No "run_limit_reached" synthesis here any more. It used to fire whenever the loop
    // completed normally and results.length reached runLimit — which is every ordinary
    // completion once each command carries exactly one job, since a one-element list is
    // never short of a limit of one. A stall, a failed upload, a genuine submission: all
    // of them got the same "run_limit_reached" label, which is not what happened and gave
    // no one anything to act on. eligible_jobs_exhausted — the value this started at —
    // already correctly describes "the loop finished the jobs it was given without being
    // interrupted"; that is true whether or not more eligible postings exist elsewhere,
    // and this command has no way to know that from in here regardless.

    const channel = resolveNotifyChannel(cfg);
    await channel.notifyRunSummary({
      applied: summary.submitted,
      needsAnswers: summary.needsAnswers,
      blocked: summary.blocked,
      stalled: summary.stalled,
      needsManual: summary.needsManual,
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
      message: describeApplyRunOutcome(results, runStopReason, runLimit, summary),
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
    const needsManual = results.some((result) => result.stopReason === "needs_manual");
    const needsAnswers = results.some((result) => result.stopReason === "needs_answers");
    const leaveOpenForHuman = shouldLeaveApplyBrowserOpen(results, runStopReason);
    if (leaveOpenForHuman) {
      logger.info("Leaving the apply browser open for a human", {
        commandId: context.command.id,
        reason: runStopReason,
        needsAnswers,
      });
      await addCommandEvent(
        context.command.id,
        "apply_browser_left_open",
        stalled || needsManual || needsAnswers
          ? "The form could not be advanced automatically. The tab is still open on it, filled in as far as the agent got."
          : "Stopped on a challenge that needs a person. The browser tab is still open on it — solve it there, then resume.",
        { runStopReason, stalled, needsManual, needsAnswers },
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
