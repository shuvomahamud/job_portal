import type { NotificationChannel } from "./channel";

/** Dashboard channel is a no-op sender — `/questions` reads pending_questions directly. */
export function createDashboardChannel(): NotificationChannel {
  return {
    name: "dashboard",
    async notifyQuestions() {
      return {};
    },
    async notifyAnswerAccepted() {},
    async notifyRunSummary() {},
  };
}
