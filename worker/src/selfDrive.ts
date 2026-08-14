/**
 * Turns the workers from a chain of phases into loops that watch the data.
 *
 * The old design was edge-triggered: a search queued scoring, scoring's completion let an
 * apply phase proceed, and each handoff had to be timed and waited for. Every hand-off was
 * a chance to lose work — a search interrupted before its last line stranded everything it
 * had found, with nothing that would ever revisit it.
 *
 * This is level-triggered instead. When a worker has nothing to claim it asks whether the
 * database implies work — anything unscored, anything scored and never applied to — and
 * creates it. Nothing coordinates with anything else, so there is no handoff to miss and
 * no position to recover: stopping and starting simply resumes, because the workers derive
 * what to do from the world rather than from where they left off.
 *
 * Discovery stays a discrete, deliberately triggered run. It costs a browser and a human's
 * patience, and it is the one step that should only happen when asked.
 */
import { getConfig } from "./config";
import {
  getActiveTargetRolesForUser,
  getCandidateProfileForUser,
  getEligibleUnappliedJobIds,
  hasOpenBlockerAlert,
  getUnscoredJobIdsForRole,
  queueApplyRunIfIdle,
  queueScoringSweepIfIdle,
} from "./db";
import { isApplyPaused } from "./apply/applyEligibility";
import { logger } from "./logger";
import { MAX_DISCOVERY_RESULTS_PER_COMMAND } from "../../src/lib/runLimits";

export type SelfDriveResult = { queued: "scoring" | "applying" | null };

/**
 * Looks for work the data implies and queues it.
 *
 * Called only when a worker found nothing to claim, so it never competes with real work,
 * and every failure is swallowed: this is an optimisation over an idle poll, and it must
 * not be able to take a worker down.
 */
export async function queueImpliedWork(
  commandTypes: string[],
): Promise<SelfDriveResult> {
  const cfg = getConfig();
  const userId = cfg.WORKER_OWNER_USER_ID;
  // Without an owner there is no way to know whose postings these are. The worker still
  // runs; it just waits to be told what to do, as it always did.
  if (!userId) return { queued: null };

  try {
    if (await isApplyPaused(userId)) return { queued: null };

    const [role] = await getActiveTargetRolesForUser(userId);
    if (!role) return { queued: null };
    const profile = await getCandidateProfileForUser(userId);
    if (!profile) return { queued: null };

    if (commandTypes.includes("run_local_llm_extraction")) {
      const unscored = await getUnscoredJobIdsForRole(userId, role.id, 1);
      if (unscored.length) {
        const queued = await queueScoringSweepIfIdle({
          parentCommandId: null,
          requestedBy: userId,
          candidateProfileId: profile.id,
          targetRoleId: role.id,
          resumeVersionId: role.resumeVersionId,
          reason: "unscored postings waiting",
        });
        if (queued) {
          logger.info("Queued scoring for unscored postings", { commandId: queued.id });
          return { queued: "scoring" };
        }
      }
    }

    // Something is waiting on the user — a CAPTCHA, a login wall — so applying stands
    // down rather than walking straight back into it. Without this the loop spins: the
    // run stops on the challenge, the worker goes idle, the same postings are still
    // unapplied, and it queues another run into the same wall every ten seconds, with a
    // notification each time. Asking for help is only waiting if the retry stops.
    //
    // Scoring is deliberately left running: it needs no browser, so a blocked Chrome is
    // no reason for the model to sit idle.
    if (commandTypes.includes("apply_to_jobs") && (await hasOpenBlockerAlert(userId))) {
      return { queued: null };
    }

    if (commandTypes.includes("apply_to_jobs") && cfg.JOB_APPLY_ENABLED) {
      const jobIds = await getEligibleUnappliedJobIds(
        userId,
        MAX_DISCOVERY_RESULTS_PER_COMMAND,
      );
      if (jobIds.length) {
        const queued = await queueApplyRunIfIdle({
          requestedBy: userId,
          jobIds,
          mode: cfg.JOB_APPLY_MODE,
        });
        if (queued) {
          logger.info("Queued applications for eligible postings", {
            commandId: queued.id,
            jobCount: jobIds.length,
          });
          return { queued: "applying" };
        }
      }
    }
  } catch (error) {
    logger.warn("Could not queue implied work", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { queued: null };
}
