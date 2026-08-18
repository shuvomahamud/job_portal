/**
 * Sends notifications to the JobAgent macOS app.
 *
 * The app pipes this process's stdout and stderr into its activity log, so a tagged JSON
 * line is all the transport that is needed. The write uses stderr with writeSync so a
 * pause that then sits in waitForHumanChallenge cannot leave the alert stuck in Node's
 * stdout buffer — that is why JobAgent never showed the CAPTCHA.
 */
import { writeSync } from "node:fs";
import {
  formatQuestionsBody,
  formatQuestionsTitle,
  formatBrowserBlockedTitle,
  formatBrowserBlockedBody,
  formatStuckTitle,
  formatStuckBody,
  type NotificationChannel,
  type NotifyAnswerAcceptedInput,
  type NotifyQuestionsInput,
  type NotifyRunSummaryInput,
  type NotifyBrowserBlockedInput,
  type NotifyStuckInput,
} from "./channel";

export const DESKTOP_NOTIFY_PREFIX = "@@JOBAGENT_NOTIFY@@";

type NotifyWrite = (line: string) => void;

let writeNotify: NotifyWrite = (line) => {
  writeSync(2, line);
};

/** Test-only hook. Pass null to restore the real stderr write. */
export function setDesktopNotifyWriter(writer: NotifyWrite | null) {
  writeNotify = writer ?? ((line) => writeSync(2, line));
}

function emit(title: string, body: string) {
  writeNotify(`${DESKTOP_NOTIFY_PREFIX}${JSON.stringify({ title, body })}\n`);
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
      if (input.stalled) parts.push(`${input.stalled} stalled`);
      if (input.needsManual) parts.push(`${input.needsManual} need you`);
      if (input.failed) parts.push(`${input.failed} failed`);
      emit("Apply run finished", parts.join(" · "));
    },
    async notifyBrowserBlocked(input: NotifyBrowserBlockedInput) {
      emit(formatBrowserBlockedTitle(input.kind), formatBrowserBlockedBody(input));
    },
    async notifyStuck(input: NotifyStuckInput) {
      emit(formatStuckTitle(input.kind), formatStuckBody(input));
    },
  };
}
