import { resolveChannel } from "./channel";
import { createDashboardChannel } from "./dashboardChannel";
import { createDesktopChannel } from "./desktopChannel";
import type { WorkerConfig } from "../config";

export function resolveNotifyChannel(cfg: WorkerConfig) {
  return resolveChannel(cfg, {
    createDesktop: createDesktopChannel,
    createDashboard: createDashboardChannel,
  });
}

export { createDashboardChannel, createDesktopChannel, resolveChannel };
export * from "./channel";
