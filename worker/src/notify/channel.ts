export type PendingQuestionSummary = {
  shortId: string;
  questionText: string;
  options: string[];
  required: boolean;
};

/**
 * One notification per application, listing every field we could not answer.
 * Previously each unanswered field raised its own alert, so a form with six gaps
 * produced six notifications for a single application.
 */
export type NotifyQuestionsInput = {
  jobTitle: string;
  company: string;
  questions: PendingQuestionSummary[];
};

export type NotifyAnswerAcceptedInput = {
  questionText: string;
  answerValue: string;
};

export type NotifyRunSummaryInput = {
  applied: number;
  needsAnswers: number;
  blocked: number;
  failed: number;
  stalled?: number;
  needsManual?: number;
};

/**
 * Form is still open but the worker cannot continue. Distinct from a CAPTCHA (that
 * already has notifyBrowserBlocked) and from unanswered fields (notifyQuestions).
 * Stalls used to land in the quiet "Apply run finished · 1 failed" summary, which
 * never asked anyone to look at the page.
 */
export type NotifyStuckInput = {
  jobTitle: string;
  company: string;
  kind: "stalled" | "needs_manual";
};

export type NotifyBrowserBlockedInput = {
  site: string;
  kind: "captcha" | "login_required" | "access_denied";
  message: string;
};

export type NotificationChannel = {
  name: "desktop" | "dashboard" | "push";
  /** Returns a channel message id keyed by question shortId, when the channel has one. */
  notifyQuestions(input: NotifyQuestionsInput): Promise<{ messageIds?: Record<string, string> }>;
  notifyAnswerAccepted(input: NotifyAnswerAcceptedInput): Promise<void>;
  notifyRunSummary(input: NotifyRunSummaryInput): Promise<void>;
  notifyBrowserBlocked(input: NotifyBrowserBlockedInput): Promise<void>;
  notifyStuck(input: NotifyStuckInput): Promise<void>;
};

/** Body text for a batched question notification. Shared so channels read alike. */
export function formatQuestionsBody(input: NotifyQuestionsInput): string {
  const where = [input.jobTitle, input.company].filter(Boolean).join(" at ");
  const lines = input.questions.map(
    (question) => `• ${question.questionText}${question.required ? " (required)" : ""}`,
  );
  return [where, ...lines].filter(Boolean).join("\n");
}

export function formatBrowserBlockedTitle(kind: NotifyBrowserBlockedInput["kind"]): string {
  if (kind === "captcha") return "CAPTCHA needs your attention";
  if (kind === "login_required") return "Job-site login required";
  return "Job site blocked the worker";
}

export function formatBrowserBlockedBody(input: NotifyBrowserBlockedInput): string {
  const next =
    input.kind === "access_denied"
      ? "Open the dashboard and choose “Open browser to unblock”."
      : "Solve it in JobAgent Chrome, then click Resume automated apply.";
  return `${input.message}\n${next}`;
}

export function formatStuckTitle(kind: NotifyStuckInput["kind"]): string {
  return kind === "stalled" ? "An application stalled" : "An application needs you";
}

export function formatStuckBody(input: NotifyStuckInput): string {
  const where = [input.jobTitle, input.company].filter(Boolean).join(" at ");
  const next =
    input.kind === "stalled"
      ? "The form could not be advanced. JobAgent Chrome is still on that page — finish it there, then click Resume automated apply."
      : "The worker stopped before submitting. JobAgent Chrome is still on that page — check the form, then click Resume automated apply.";
  return [where, next].filter(Boolean).join("\n");
}

export function formatQuestionsTitle(input: NotifyQuestionsInput): string {
  const count = input.questions.length;
  if (count === 1) {
    return input.questions[0]!.required
      ? "An application needs an answer"
      : "An application has a question";
  }
  return `An application needs ${count} answers`;
}

export type NotifyConfig = {
  JOB_APPLY_NOTIFY_CHANNEL: "desktop" | "dashboard";
  /** Optional so callers that predate push, including tests, still typecheck. */
  JOB_APPLY_PUSH_ENABLED?: boolean;
  NTFY_TOPIC?: string;
};

/**
 * Sends to every channel, so a phone notification adds to the Mac one rather than
 * replacing it.
 *
 * Delivery is sequential and each channel swallows its own failures, so one unreachable
 * service cannot stop the others or fail the application that triggered it.
 */
export function fanOut(channels: NotificationChannel[]): NotificationChannel {
  if (channels.length === 1) return channels[0]!;
  const primary = channels[0]!;
  return {
    name: primary.name,
    async notifyQuestions(input) {
      let messageIds: Record<string, string> | undefined;
      for (const channel of channels) {
        const result = await channel.notifyQuestions(input);
        // The first channel that knows its own message ids wins; only the dashboard
        // channel has them, and answering relies on them being the dashboard's.
        if (!messageIds && result.messageIds) messageIds = result.messageIds;
      }
      return messageIds ? { messageIds } : {};
    },
    async notifyAnswerAccepted(input) {
      for (const channel of channels) await channel.notifyAnswerAccepted(input);
    },
    async notifyRunSummary(input) {
      for (const channel of channels) await channel.notifyRunSummary(input);
    },
    async notifyBrowserBlocked(input) {
      for (const channel of channels) await channel.notifyBrowserBlocked(input);
    },
    async notifyStuck(input) {
      for (const channel of channels) await channel.notifyStuck(input);
    },
  };
}

export function resolveChannel(
  cfg: NotifyConfig,
  deps: {
    createDesktop: () => NotificationChannel;
    createDashboard: () => NotificationChannel;
    createPush?: () => NotificationChannel;
  },
): NotificationChannel {
  // The dashboard channel records the question for the web UI; desktop also raises a
  // native notification. Anything unrecognised falls back to the dashboard.
  const local = cfg.JOB_APPLY_NOTIFY_CHANNEL === "desktop"
    ? deps.createDesktop()
    : deps.createDashboard();

  // Push is additive. Without a topic there is nothing to publish to, so an enabled flag
  // with no topic configured stays silent rather than erroring on every notification.
  if (!cfg.JOB_APPLY_PUSH_ENABLED || !cfg.NTFY_TOPIC || !deps.createPush) return local;
  return fanOut([local, deps.createPush()]);
}
