import { resolveChannel } from "./channel";
import { createDashboardChannel } from "./dashboardChannel";
import { createDesktopChannel } from "./desktopChannel";
import { createPushChannel } from "./pushChannel";
import type { WorkerConfig } from "../config";
import { logger } from "../logger";

export function resolveNotifyChannel(cfg: WorkerConfig) {
  if (cfg.JOB_APPLY_PUSH_ENABLED && !cfg.NTFY_TOPIC) {
    logger.warn(
      "Phone notifications are on, but no ntfy topic is set — alerts stay on this Mac until JobAgent Settings has the same topic the ntfy app is subscribed to.",
    );
  }
  return resolveChannel(cfg, {
    createDesktop: createDesktopChannel,
    createDashboard: createDashboardChannel,
    createPush: () =>
      createPushChannel({
        serverUrl: cfg.NTFY_SERVER,
        topic: cfg.NTFY_TOPIC ?? "",
        timeoutMs: cfg.NTFY_TIMEOUT_MS,
      }),
  });
}

export { createDashboardChannel, createDesktopChannel, createPushChannel, resolveChannel };
export * from "./channel";
