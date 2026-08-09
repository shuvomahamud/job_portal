import { and, eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../../../src/db/schema";
import { createArtifactContext, finishTrace, screenshot, startTrace } from "../apply/artifacts";
import { isApplyPaused } from "../apply/applyEligibility";
import { adapterFor, sourceUrlAllowed } from "../apply/applySteps";
import { loadPlaywright, openBrowserSession } from "../browser/session";
import { getConfig } from "../config";
import { addCommandEvent, getWorkerDb } from "../db";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";

const payloadSchema = z.object({ applicationId: z.string().uuid() }).strict();

export async function handleVerifySubmission(
  payload: unknown,
  context: HandlerContext,
): Promise<HandlerResult> {
  const { applicationId } = payloadSchema.parse(payload);
  const userId = requireCommandUserId(context.command.requestedBy);
  const cfg = getConfig();
  if (!cfg.JOB_APPLY_ENABLED) {
    throw new Error("Job apply verification is disabled on this worker.");
  }
  if (await isApplyPaused(userId)) {
    return {
      status: "completed",
      resultJson: { paused: true },
      message: "Automated apply is paused for this user.",
    };
  }
  const database = getWorkerDb();
  const [row] = await database
    .select({ application: schema.applications, job: schema.jobs })
    .from(schema.applications)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.applications.jobId))
    .where(
      and(
        eq(schema.applications.id, applicationId),
        eq(schema.applications.userId, userId),
        eq(schema.applications.status, "submission_unknown"),
      ),
    )
    .limit(1);
  if (!row) throw new Error("Unknown submission was not found for this user.");
  if (!sourceUrlAllowed(row.job.source, row.job.sourceUrl)) {
    throw new Error("Submission verification only supports Indeed and Dice URLs.");
  }

  const playwright = await loadPlaywright();
  const browserSession = await openBrowserSession(playwright, cfg);
  const page = await browserSession.context.newPage();
  const artifacts = await createArtifactContext({
    commandId: context.command.id,
    jobId: row.job.id,
    artifactDir: cfg.JOB_APPLY_ARTIFACT_DIR,
    page,
    context: browserSession.context,
  });
  await startTrace(artifacts);
  try {
    await page.goto(row.application.applyUrl || row.job.sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: cfg.JOB_BROWSER_NAVIGATION_TIMEOUT_MS,
    });
    const confirmed = await adapterFor(row.job.source).detectSuccess(page);
    await screenshot(artifacts, confirmed ? "reverify-confirmed" : "reverify-unconfirmed");
    if (confirmed) {
      await database.batch([
        database
          .update(schema.applications)
          .set({
            status: "applied",
            appliedAt: new Date(),
            confirmationEvidence: { detected: true, source: "reverify" },
            stopReason: "reverify_confirmed",
            updatedAt: new Date(),
          })
          .where(eq(schema.applications.id, applicationId)),
        database
          .update(schema.jobs)
          .set({ status: "applied", updatedAt: new Date() })
          .where(eq(schema.jobs.id, row.job.id)),
      ]);
    } else {
      await database
        .update(schema.applications)
        .set({ stopReason: "reverify_unconfirmed", updatedAt: new Date() })
        .where(eq(schema.applications.id, applicationId));
    }
    await finishTrace(artifacts, !confirmed);
    await addCommandEvent(
      context.command.id,
      "submission_reverified",
      confirmed ? "Submission confirmation was detected." : "Submission remains unknown.",
      { jobId: row.job.id, applicationId, confirmed, artifacts: artifacts.paths },
    );
    return {
      status: "completed",
      resultJson: { applicationId, confirmed, artifacts: artifacts.paths },
      message: confirmed ? "Submission confirmed." : "Submission remains unknown.",
    };
  } finally {
    await page.close().catch(() => undefined);
    await browserSession.close().catch(() => undefined);
  }
}
