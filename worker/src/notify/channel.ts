export type NotifyQuestionInput = {
  shortId: string;
  jobTitle: string;
  company: string;
  questionText: string;
  options: string[];
  required: boolean;
  chatId?: string;
};

export type NotifyAnswerAcceptedInput = {
  chatId: string;
  messageId: string;
  questionText: string;
  answerValue: string;
};

export type NotifyRunSummaryInput = {
  applied: number;
  needsAnswers: number;
  blocked: number;
  failed: number;
  chatId?: string;
};

export type NotificationChannel = {
  name: "telegram" | "dashboard";
  notifyQuestion(input: NotifyQuestionInput): Promise<{ messageId?: string }>;
  notifyAnswerAccepted(input: NotifyAnswerAcceptedInput): Promise<void>;
  notifyRunSummary(input: NotifyRunSummaryInput): Promise<void>;
};

export type NotifyConfig = {
  JOB_APPLY_NOTIFY_CHANNEL: "telegram" | "dashboard";
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_CHAT_ID?: string;
};

export function resolveChannel(
  cfg: NotifyConfig,
  deps: {
    createTelegram: (token: string, chatId: string) => NotificationChannel;
    createDashboard: () => NotificationChannel;
  },
): NotificationChannel {
  if (
    cfg.JOB_APPLY_NOTIFY_CHANNEL === "telegram" &&
    cfg.TELEGRAM_BOT_TOKEN &&
    cfg.TELEGRAM_ALLOWED_CHAT_ID
  ) {
    return deps.createTelegram(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_ALLOWED_CHAT_ID);
  }
  return deps.createDashboard();
}
