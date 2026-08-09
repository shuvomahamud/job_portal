import type {
  NotificationChannel,
  NotifyAnswerAcceptedInput,
  NotifyQuestionInput,
  NotifyRunSummaryInput,
} from "./channel";

async function telegramApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok || json.ok === false) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

export function createTelegramChannel(token: string, defaultChatId: string): NotificationChannel {
  return {
    name: "telegram",
    async notifyQuestion(input: NotifyQuestionInput) {
      const chatId = input.chatId ?? defaultChatId;
      const header = `Question for ${input.jobTitle} @ ${input.company}\n\n${input.questionText}`;
      const options = input.options.map((option) => String(option));

      let body: Record<string, unknown>;
      if (options.length >= 2 && options.length <= 8) {
        body = {
          chat_id: chatId,
          text: header,
          reply_markup: {
            inline_keyboard: options.map((option, index) => [
              {
                text: option.slice(0, 64),
                callback_data: `a:${input.shortId}:${index}`,
              },
            ]),
          },
        };
      } else if (options.length > 8) {
        const listed = options.map((option, index) => `${index + 1}. ${option}`).join("\n");
        body = {
          chat_id: chatId,
          text: `${header}\n\nReply with the option number:\n${listed}`,
          reply_markup: { force_reply: true },
        };
      } else {
        body = {
          chat_id: chatId,
          text: `${header}${input.required ? "\n\n(Required)" : ""}`,
          reply_markup: { force_reply: true },
        };
      }

      const result = await telegramApi(token, "sendMessage", body);
      const message = result.result as { message_id?: number } | undefined;
      return { messageId: message?.message_id != null ? String(message.message_id) : undefined };
    },

    async notifyAnswerAccepted(input: NotifyAnswerAcceptedInput) {
      await telegramApi(token, "editMessageText", {
        chat_id: input.chatId,
        message_id: Number(input.messageId),
        text: `Answered: ${input.questionText}\n→ ${input.answerValue}`,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => undefined);
    },

    async notifyRunSummary(input: NotifyRunSummaryInput) {
      const chatId = input.chatId ?? defaultChatId;
      await telegramApi(token, "sendMessage", {
        chat_id: chatId,
        text: `Apply run summary\napplied=${input.applied} needs_answers=${input.needsAnswers} blocked=${input.blocked} failed=${input.failed}`,
      });
    },
  };
}
