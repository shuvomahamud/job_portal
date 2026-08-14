import { withClaimHeartbeat } from "./claimHeartbeat";
import { getConfig, sleep } from "./config";
import { claimCommand, completeCommand, failCommand } from "./dashboardClient";
import { addCommandEvent, getCommandStatus, recoverStaleClaims } from "./db";
import { dispatchCommand, supportedPhase2CommandTypes } from "./dispatcher";
import { logger } from "./logger";
import { verifyOllamaHealth } from "./ai/ollamaClient";
import { acquireWorkerProcessLock } from "./processLock";
import { queueImpliedWork } from "./selfDrive";
import type { DashboardCommand } from "./types";

let stopping = false;

/** How long a graceful stop may take before the process leaves anyway. */
const STOP_DEADLINE_MS = 20_000;

/**
 * Setting a flag was not enough to stop this process.
 *
 * The loop only reads `stopping` between commands, so a signal arriving while the worker
 * sits inside a browser call — Playwright's own timeouts run to a minute or more — was
 * simply not acted on. The Mac app then waited on a process that acknowledged the signal
 * and never left, and its Start button stayed disabled for as long as that lasted.
 *
 * So a stop is now a promise rather than a request: the flag first, and if the process is
 * still here when the deadline passes it exits regardless. A second signal skips the wait
 * entirely, which is what makes Force Stop mean anything.
 */
function requestStop(signal: string) {
  if (stopping) {
    logger.warn(`Received ${signal} again; exiting now.`);
    process.exit(0);
  }
  stopping = true;
  logger.warn(`Received ${signal}; stopping after current command.`);
  const deadline = setTimeout(() => {
    logger.warn("Graceful stop timed out; exiting.", { afterMs: STOP_DEADLINE_MS });
    process.exit(0);
  }, STOP_DEADLINE_MS);
  // Never hold the process open on the timer's account.
  deadline.unref();
}

process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

/** Best-effort: if this check itself fails, fall back to normal failure reporting. */
async function wasCanceled(commandId: string): Promise<boolean> {
  try {
    return (await getCommandStatus(commandId)) === "canceled";
  } catch {
    return false;
  }
}

async function processCommand(command: DashboardCommand) {
  logger.info("Processing command", { commandId: command.id, type: command.type });
  const cfg = getConfig();
  try {
    await addCommandEvent(command.id, "worker_started", "Phase 2 worker started processing command.", {
      type: command.type,
    });
    const result = await withClaimHeartbeat(
      command,
      cfg.WORKER_HEARTBEAT_INTERVAL_SECONDS * 1000,
      (claimGuard) => dispatchCommand(command, claimGuard),
    );
    await completeCommand(command.id, result);
    logger.info("Completed command", { commandId: command.id, type: command.type });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    // A command the user stopped is not a failure. The dashboard already set it to
    // canceled and recorded why, which also means completeCommand and failCommand both
    // reject it for no longer being claimed — so reporting it would put two alarming
    // errors in the log for something that was asked for on purpose.
    if (await wasCanceled(command.id)) {
      logger.info("Command stopped from the dashboard", {
        commandId: command.id,
        type: command.type,
      });
      return;
    }
    logger.error("Command failed", { commandId: command.id, type: command.type, error: message });
    try {
      await failCommand(command.id, message, { failedAt: new Date().toISOString() });
    } catch (failError) {
      logger.error("Could not mark command failed", {
        commandId: command.id,
        error: failError instanceof Error ? failError.message : "Unknown fail-report error",
      });
    }
  }
}

export async function runWorkerLoop() {
  const cfg = getConfig();
  const workerLock = acquireWorkerProcessLock(cfg.WORKER_ID);
  const commandTypes = cfg.workerCommandTypes.filter((type) => supportedPhase2CommandTypes().includes(type));
  if (!commandTypes.length) {
    throw new Error(`No Phase 2 command types enabled. Supported: ${supportedPhase2CommandTypes().join(", ")}`);
  }
  if (commandTypes.includes("run_local_llm_extraction")) {
    try {
      await verifyOllamaHealth({
        baseUrl: cfg.OLLAMA_BASE_URL,
        allowedRemoteHosts: cfg.ollamaAllowedRemoteHosts,
        model: cfg.OLLAMA_MODEL,
        requestTimeoutMs: cfg.OLLAMA_REQUEST_TIMEOUT_MS,
        keepAlive: cfg.OLLAMA_KEEP_ALIVE,
      });
      logger.info("Local Ollama health check passed", { model: cfg.OLLAMA_MODEL });
    } catch (error) {
      logger.warn("Local Ollama health check failed; matching commands will retry when claimed.", {
        error: error instanceof Error ? error.message : "Unknown Ollama health error",
      });
    }
  }
  logger.info("Starting Phase 2 job worker", {
    workerId: cfg.WORKER_ID,
    pollIntervalSeconds: cfg.WORKER_POLL_INTERVAL_SECONDS,
    claimLimit: cfg.WORKER_CLAIM_LIMIT,
    maxConcurrency: cfg.WORKER_MAX_CONCURRENCY,
    commandTypes,
  });

  let idlePolls = 0;
  let nextRecoveryAt = 0;
  let consecutiveClaimFailures = 0;
  // Four missed beats is enough to prove a worker is gone, while leaving ample room for
  // a temporarily slow database request. This replaces the old one-hour dead period.
  const staleClaimMinutes = Math.max(
    3,
    Math.ceil((cfg.WORKER_HEARTBEAT_INTERVAL_SECONDS * 4) / 60),
  );

  while (!stopping) {
    const now = Date.now();
    if (now >= nextRecoveryAt) {
      try {
        const recovered = await recoverStaleClaims(staleClaimMinutes);
        if (recovered.length) logger.warn("Recovered stale claimed commands", { commandIds: recovered });
      } catch (error) {
        logger.warn("Stale claim recovery failed", { error: error instanceof Error ? error.message : "Unknown error" });
      }
      nextRecoveryAt = now + 60 * 1000;
    }

    let claimed = 0;
    let claimFailed = false;
    for (let i = 0; i < cfg.WORKER_CLAIM_LIMIT && !stopping; i += 1) {
      let command: DashboardCommand | null;
      try {
        command = await claimCommand(commandTypes);
      } catch (error) {
        // A dashboard that is down, slow, or throwing must not take the worker with it.
        // Letting this escape ends the loop, the process exits, and nothing runs again
        // until someone notices and restarts it by hand.
        claimFailed = true;
        consecutiveClaimFailures += 1;
        logger.error("Could not claim a command from the dashboard", {
          error: error instanceof Error ? error.message : "Unknown claim error",
          consecutiveFailures: consecutiveClaimFailures,
        });
        break;
      }
      consecutiveClaimFailures = 0;
      if (!command) break;
      claimed += 1;
      await processCommand(command);
    }

    if (claimFailed) {
      // Back off further the longer the dashboard stays unreachable, so a sustained
      // outage is not hammered every ten seconds.
      const backoffSeconds = Math.min(
        cfg.WORKER_POLL_INTERVAL_SECONDS * consecutiveClaimFailures,
        cfg.WORKER_IDLE_BACKOFF_MAX_SECONDS,
      );
      await sleep(backoffSeconds * 1000);
      continue;
    }

    if (claimed === 0) {
      // Nothing was waiting, so look at the data instead of the queue: anything unscored,
      // anything scored and never applied to. This is what makes stopping and starting
      // resume by itself — there is no position to recover, only a world to look at.
      const implied = await queueImpliedWork(commandTypes);
      if (implied.queued) {
        idlePolls = 0;
        continue;
      }

      idlePolls += 1;
      const backoffSeconds = Math.min(
        cfg.WORKER_POLL_INTERVAL_SECONDS + Math.floor(idlePolls / 30) * cfg.WORKER_POLL_INTERVAL_SECONDS,
        cfg.WORKER_IDLE_BACKOFF_MAX_SECONDS,
      );
      logger.debug("No command claimed; sleeping", { backoffSeconds });
      await sleep(backoffSeconds * 1000);
    } else {
      idlePolls = 0;
      await sleep(cfg.WORKER_POLL_INTERVAL_SECONDS * 1000);
    }
  }

  logger.info("Worker stopped.");
  workerLock.release();
}

if (process.argv[1]?.endsWith("worker/src/runner.ts")) {
  runWorkerLoop().catch((error) => {
    logger.error("Worker crashed", { error: error instanceof Error ? error.message : "Unknown crash" });
    process.exit(1);
  });
}
