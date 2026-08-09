import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveNumberedOptionReply,
  validateAnswerForQuestion,
} from "../../src/lib/answerValidation";
import { resolveChannel } from "../src/notify/channel";
import { createDashboardChannel } from "../src/notify/dashboardChannel";

test("validateAnswerForQuestion accepts an unambiguous option", () => {
  const result = validateAnswerForQuestion(
    {
      answerType: "select",
      category: "sponsorship_required",
      options: ["Yes", "No"],
      required: true,
    },
    "no",
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, "No");
});

test("validateAnswerForQuestion rejects out-of-range years", () => {
  const result = validateAnswerForQuestion(
    {
      answerType: "text",
      category: "years_csharp",
      options: [],
      required: true,
    },
    "99",
  );
  assert.equal(result.ok, false);
});

test("numbered Telegram replies resolve options only for long option lists", () => {
  const options = Array.from({ length: 10 }, (_, index) => `Option ${index + 1}`);
  assert.equal(resolveNumberedOptionReply(options, "3"), "Option 3");
  assert.equal(resolveNumberedOptionReply(options, "11"), null);
  assert.equal(resolveNumberedOptionReply(["One", "Two"], "1"), null);
});

test("resolveChannel falls back to dashboard when Telegram is unset", () => {
  const channel = resolveChannel(
    { JOB_APPLY_NOTIFY_CHANNEL: "telegram" },
    {
      createTelegram: () => {
        throw new Error("should not create telegram");
      },
      createDashboard: createDashboardChannel,
    },
  );
  assert.equal(channel.name, "dashboard");
});
