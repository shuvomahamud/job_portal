import { resolveChannel } from "./channel";
import { createDashboardChannel } from "./dashboardChannel";
import { createTelegramChannel } from "./telegramChannel";
import type { WorkerConfig } from "../config";

export function resolveNotifyChannel(cfg: WorkerConfig) {
  return resolveChannel(cfg, {
    createTelegram: createTelegramChannel,
    createDashboard: createDashboardChannel,
  });
}

export { createDashboardChannel, createTelegramChannel, resolveChannel };
