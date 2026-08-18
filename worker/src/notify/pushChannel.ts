/**
 * Sends notifications to a phone and watch through ntfy.
 *
 * The desktop channel only ever reaches the Mac: Apple Watch mirrors iPhone notifications,
 * not macOS ones, so a run that stalls at 2am is invisible until someone sits back down at
 * the machine. ntfy needs no account and no SDK — a topic name is the whole subscription,
 * and publishing is one POST.
 *
 * Keep the topic name long and unguessable. On the public server anyone who knows a topic
 * can read it, and these notifications carry job titles and company names.
 */
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
import { logger } from "../logger";

export type PushChannelOptions = {
  serverUrl: string;
  topic: string;
  timeoutMs: number;
};

/**
 * ntfy priorities: 5 breaks through a phone's Do Not Disturb, 3 is a normal alert, 2 is
 * quiet. A blocked run is the only thing worth waking someone for — it is the one state
 * where nothing progresses until a person acts.
 */
type Priority = 2 | 3 | 5;

export function createPushChannel(options: PushChannelOptions): NotificationChannel {
  const endpoint = `${options.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(options.topic)}`;

  async function publish(
    title: string,
    body: string,
    priority: Priority,
    tags: string[],
  ): Promise<void> {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          // Header values must be latin-1; titles carry company names that may not be.
          Title: asciiHeader(title),
          Priority: String(priority),
          Tags: tags.join(","),
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!response.ok) {
        logger.warn("Push notification rejected", {
          status: response.status,
          topic: options.topic,
        });
      }
    } catch (error) {
      // A notification is never worth failing an application over. The desktop channel and
      // the dashboard still have the same information.
      logger.warn("Push notification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    name: "push",
    async notifyQuestions(input: NotifyQuestionsInput) {
      if (!input.questions.length) return {};
      await publish(
        formatQuestionsTitle(input),
        formatQuestionsBody(input),
        input.questions.some((question) => question.required) ? 5 : 3,
        ["question"],
      );
      return {};
    },
    async notifyAnswerAccepted(input: NotifyAnswerAcceptedInput) {
      await publish("Answer saved", `${input.questionText}\n→ ${input.answerValue}`, 2, [
        "white_check_mark",
      ]);
    },
    async notifyRunSummary(input: NotifyRunSummaryInput) {
      const parts = [`${input.applied} applied`];
      if (input.needsAnswers) parts.push(`${input.needsAnswers} need answers`);
      if (input.blocked) parts.push(`${input.blocked} blocked`);
      if (input.stalled) parts.push(`${input.stalled} stalled`);
      if (input.needsManual) parts.push(`${input.needsManual} need you`);
      if (input.failed) parts.push(`${input.failed} failed`);
      const needsYou = Boolean(input.needsAnswers || input.blocked || input.stalled || input.needsManual);
      await publish("Apply run finished", parts.join(" · "), needsYou ? 3 : 2, ["checkered_flag"]);
    },
    async notifyBrowserBlocked(input: NotifyBrowserBlockedInput) {
      // The one that has to cut through. Until this is dealt with, the run is stopped and
      // the browser is holding the challenge open waiting for a person.
      await publish(
        formatBrowserBlockedTitle(input.kind),
        formatBrowserBlockedBody(input),
        5,
        ["rotating_light"],
      );
    },
    async notifyStuck(input: NotifyStuckInput) {
      await publish(formatStuckTitle(input.kind), formatStuckBody(input), 5, ["rotating_light"]);
    },
  };
}

/** Strips anything a latin-1 HTTP header cannot carry, so a stray character is not fatal. */
export function asciiHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[^\x20-\x7E]/g, "").trim() || "JobAgent";
}
