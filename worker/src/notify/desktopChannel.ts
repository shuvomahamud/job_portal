/**
 * Sends notifications to the JobAgent macOS app.
 *
 * The app already pipes this process's stdout into its activity log, so a tagged JSON line
 * is all the transport that is needed — no daemon, no port, no extra dependency. The app
 * recognises the prefix, posts a native notification, and keeps the line out of the log.
 * When the worker runs outside the app the line is simply harmless text.
 */
import {
  formatQuestionsBody,
  formatQuestionsTitle,
  formatBrowserBlockedTitle,
  formatBrowserBlockedBody,
  type NotificationChannel,
  type NotifyAnswerAcceptedInput,
  type NotifyQuestionsInput,
  type NotifyRunSummaryInput,
  type NotifyBrowserBlockedInput,
} from "./channel";

export const DESKTOP_NOTIFY_PREFIX = "@@JOBAGENT_NOTIFY@@";

function emit(title: string, body: string) {
  process.stdout.write(`${DESKTOP_NOTIFY_PREFIX}${JSON.stringify({ title, body })}\n`);
}

export function createDesktopChannel(): NotificationChannel {
  return {
    name: "desktop",
    async notifyQuestions(input: NotifyQuestionsInput) {
      if (!input.questions.length) return {};
      emit(formatQuestionsTitle(input), formatQuestionsBody(input));
      return {};
    },
    async notifyAnswerAccepted(input: NotifyAnswerAcceptedInput) {
      emit("Answer saved", `${input.questionText}\n→ ${input.answerValue}`);
    },
    async notifyRunSummary(input: NotifyRunSummaryInput) {
      const parts = [`${input.applied} applied`];
      if (input.needsAnswers) parts.push(`${input.needsAnswers} need answers`);
      if (input.blocked) parts.push(`${input.blocked} blocked`);
      if (input.failed) parts.push(`${input.failed} failed`);
      emit("Apply run finished", parts.join(" · "));
    },
    async notifyBrowserBlocked(input: NotifyBrowserBlockedInput) {
      emit(formatBrowserBlockedTitle(input.kind), formatBrowserBlockedBody(input));
    },
  };
}
