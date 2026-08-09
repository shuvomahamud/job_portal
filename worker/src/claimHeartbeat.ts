import { getConfig } from "./config";
import { heartbeatCommand } from "./db";
import { logger } from "./logger";
import type { DashboardCommand } from "./types";

export type ClaimGuard = {
  readonly lost: boolean;
  readonly reason: string | null;
};

export async function withClaimHeartbeat<T>(
  command: DashboardCommand,
  intervalMs: number,
  run: (guard: ClaimGuard) => Promise<T>,
): Promise<T> {
  const guard: { lost: boolean; reason: string | null } = {
    lost: false,
    reason: null,
  };
  const workerId = getConfig().WORKER_ID;

  const tick = async () => {
    if (guard.lost) return;
    try {
      const ok = await heartbeatCommand(command.id, workerId);
      if (!ok) {
        guard.lost = true;
        guard.reason = "Claim lost, stolen, or command canceled.";
        logger.warn("Command claim lost during heartbeat", {
          commandId: command.id,
          type: command.type,
        });
      }
    } catch (error) {
      logger.warn("Command heartbeat failed", {
        commandId: command.id,
        error: error instanceof Error ? error.message : "Unknown heartbeat error",
      });
    }
  };

  // Establish an initial heartbeat so recoverStaleClaims sees a fresh stamp
  // even if the first interval has not fired yet.
  await tick();
  if (guard.lost) {
    throw new Error(guard.reason ?? "Command claim was lost before dispatch.");
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();

  try {
    return await run(guard);
  } finally {
    clearInterval(timer);
  }
}
