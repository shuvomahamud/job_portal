import { withClaimHeartbeat } from "./claimHeartbeat";
import { getConfig, sleep } from "./config";
import { claimCommand, completeCommand, failCommand } from "./dashboardClient";
import { addCommandEvent, recoverStaleClaims } from "./db";
import { dispatchCommand, supportedPhase2CommandTypes } from "./dispatcher";
import { logger } from "./logger";
import { verifyOllamaHealth } from "./ai/ollamaClient";
import type { DashboardCommand } from "./types";

let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
  logger.warn("Received SIGINT; stopping after current command.");
});
process.on("SIGTERM", () => {
  stopping = true;
  logger.warn("Received SIGTERM; stopping after current command.");
});

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

  while (!stopping) {
    const now = Date.now();
    if (now >= nextRecoveryAt) {
      try {
        const recovered = await recoverStaleClaims(60);
        if (recovered.length) logger.warn("Recovered stale claimed commands", { commandIds: recovered });
      } catch (error) {
        logger.warn("Stale claim recovery failed", { error: error instanceof Error ? error.message : "Unknown error" });
      }
      nextRecoveryAt = now + 15 * 60 * 1000;
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
}

if (process.argv[1]?.endsWith("worker/src/runner.ts")) {
  runWorkerLoop().catch((error) => {
    logger.error("Worker crashed", { error: error instanceof Error ? error.message : "Unknown crash" });
    process.exit(1);
  });
}
