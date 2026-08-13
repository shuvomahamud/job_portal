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
};

export type NotificationChannel = {
  name: "desktop" | "dashboard";
  /** Returns a channel message id keyed by question shortId, when the channel has one. */
  notifyQuestions(input: NotifyQuestionsInput): Promise<{ messageIds?: Record<string, string> }>;
  notifyAnswerAccepted(input: NotifyAnswerAcceptedInput): Promise<void>;
  notifyRunSummary(input: NotifyRunSummaryInput): Promise<void>;
};

/** Body text for a batched question notification. Shared so channels read alike. */
export function formatQuestionsBody(input: NotifyQuestionsInput): string {
  const where = [input.jobTitle, input.company].filter(Boolean).join(" at ");
  const lines = input.questions.map(
    (question) => `• ${question.questionText}${question.required ? " (required)" : ""}`,
  );
  return [where, ...lines].filter(Boolean).join("\n");
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
};

export function resolveChannel(
  cfg: NotifyConfig,
  deps: {
    createDesktop: () => NotificationChannel;
    createDashboard: () => NotificationChannel;
  },
): NotificationChannel {
  // The dashboard channel records the question for the web UI; desktop also raises a
  // native notification. Anything unrecognised falls back to the dashboard.
  return cfg.JOB_APPLY_NOTIFY_CHANNEL === "desktop"
    ? deps.createDesktop()
    : deps.createDashboard();
}
