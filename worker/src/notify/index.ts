import { resolveChannel } from "./channel";
import { createDashboardChannel } from "./dashboardChannel";
import { createDesktopChannel } from "./desktopChannel";
import { createPushChannel } from "./pushChannel";
import type { WorkerConfig } from "../config";

export function resolveNotifyChannel(cfg: WorkerConfig) {
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
