/**
 * Shared abort state for a forced worker stop.
 *
 * A force-stop used to mark only the command `failed` and then spend up to four seconds
 * reporting that to the dashboard. Meanwhile the apply handler kept running, and the
 * last check before the irreversible submit click only looked for `canceled` — not
 * `failed`, and not a local flag. The click could still fire, and the application row
 * stayed in `draft` / `filling`, which blocks every later retry.
 *
 * The flag is set synchronously, before any await, so the apply loop can refuse that
 * click even while reporting is still in flight. The in-flight apply record lets the
 * same path persist the application as `needs_manual` or `submission_unknown`.
 */
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { getCommandStatus, getWorkerDb } from "./db";

let aborted = false;

export type InFlightApply = {
  commandId: string;
  userId: string;
  jobId: string;
  submittingWritten: boolean;
};

let inFlightApply: InFlightApply | null = null;

export function isWorkerAborted(): boolean {
  return aborted;
}

/** First action of a forced stop: no await, visible to every in-flight apply check. */
export function abortWorker(): void {
  aborted = true;
}

export function resetWorkerAbortForTests(): void {
  aborted = false;
  inFlightApply = null;
}

export function trackInFlightApply(info: {
  commandId: string;
  userId: string;
  jobId: string;
}): void {
  inFlightApply = { ...info, submittingWritten: false };
}

export function markInFlightSubmitting(): void {
  if (inFlightApply) inFlightApply.submittingWritten = true;
}

export function clearInFlightApply(): void {
  inFlightApply = null;
}

export function getInFlightApply(): InFlightApply | null {
  return inFlightApply;
}

/**
 * True when this apply must not continue, and must not click submit.
 *
 * `failed` is included because a forced stop reports the command as failed, not
 * canceled. Re-checks the local flag after the dashboard read so a stop that
 * arrives during that await still wins.
 */
export async function applyShouldHalt(commandId: string): Promise<boolean> {
  if (aborted) return true;
  const status = await getCommandStatus(commandId);
  if (aborted) return true;
  return status === "canceled" || status === "failed";
}

export async function persistAbortedApplication(): Promise<void> {
  const current = inFlightApply;
  if (!current) return;
  const status = current.submittingWritten ? "submission_unknown" : "needs_manual";
  const stopReason = current.submittingWritten
    ? "worker_stopped_during_submit"
    : "worker_stopped_before_submit";
  await getWorkerDb()
    .update(schema.applications)
    .set({ status, stopReason, updatedAt: new Date() })
    .where(
      and(
        eq(schema.applications.userId, current.userId),
        eq(schema.applications.jobId, current.jobId),
        inArray(schema.applications.status, ["draft", "filling", "submitting"]),
      ),
    );
}
