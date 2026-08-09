import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { pendingQuestions } from "@/db/schema";
import { acceptPendingAnswer } from "@/services/pendingAnswers";
import { resolveNumberedOptionReply } from "@/lib/answerValidation";
import { createTelegramChannel } from "../../../../../worker/src/notify/telegramChannel";

export const runtime = "nodejs";

type TelegramUpdate = {
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number } };
  };
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number };
    reply_to_message?: { message_id?: number };
  };
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export async function POST(request: Request) {
  const secret = env("TELEGRAM_WEBHOOK_SECRET");
  const allowedChatId = env("TELEGRAM_ALLOWED_CHAT_ID");
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!secret || !allowedChatId || !token) {
    return NextResponse.json({ error: "Telegram is not configured." }, { status: 503 });
  }

  const header = request.headers.get("x-telegram-bot-api-secret-token");
  if (header !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;
  const chatId = String(
    update.callback_query?.message?.chat?.id ?? update.message?.chat?.id ?? "",
  );
  if (chatId !== allowedChatId) {
    return NextResponse.json({ error: "Forbidden chat" }, { status: 403 });
  }

  const db = getDb();
  let question = null as typeof pendingQuestions.$inferSelect | null;
  let rawAnswer = "";

  if (update.callback_query?.data) {
    const match = /^a:([^:]+):(\d+)$/.exec(update.callback_query.data);
    if (!match) {
      return NextResponse.json({ error: "Invalid callback" }, { status: 400 });
    }
    const shortId = match[1]!;
    const optionIndex = Number(match[2]);
    const [row] = await db
      .select()
      .from(pendingQuestions)
      .where(and(eq(pendingQuestions.shortId, shortId), eq(pendingQuestions.status, "open")))
      .limit(1);
    if (!row) return NextResponse.json({ ok: true, ignored: true });
    const options = (row.optionsJson ?? []).map((option) => String(option ?? ""));
    if (optionIndex < 0 || optionIndex >= options.length) {
      return NextResponse.json({ error: "Option out of range" }, { status: 400 });
    }
    question = row;
    rawAnswer = options[optionIndex]!;
  } else if (update.message?.reply_to_message?.message_id != null && update.message.text) {
    const messageId = String(update.message.reply_to_message.message_id);
    const [row] = await db
      .select()
      .from(pendingQuestions)
      .where(
        and(
          eq(pendingQuestions.channelMessageId, messageId),
          eq(pendingQuestions.status, "open"),
        ),
      )
      .limit(1);
    if (!row) return NextResponse.json({ ok: true, ignored: true });
    question = row;
    const options = row.optionsJson ?? [];
    const numberedOption = resolveNumberedOptionReply(options, update.message.text);
    if (options.length > 8 && /^\s*\d+\s*$/.test(update.message.text)) {
      if (!numberedOption) {
        return NextResponse.json(
          { error: `Choose a number from 1 to ${options.length}.` },
          { status: 400 },
        );
      }
      rawAnswer = numberedOption;
    } else {
      rawAnswer = update.message.text;
    }
  } else {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const result = await acceptPendingAnswer({
    question,
    rawAnswer,
    source: "user_reply",
  });

  if (update.callback_query?.id) {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: update.callback_query.id,
        text: result.ok ? "Saved" : result.message,
        show_alert: !result.ok,
      }),
    }).catch(() => undefined);
  }

  if (result.ok) {
    const messageId =
      question.channelMessageId ??
      (update.callback_query?.message?.message_id != null
        ? String(update.callback_query.message.message_id)
        : undefined);
    if (messageId) {
      const channel = createTelegramChannel(token, allowedChatId);
      await channel.notifyAnswerAccepted({
        chatId,
        messageId,
        questionText: question.questionText,
        answerValue: result.value,
      });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, message: result.message }, { status: 400 });
}
