import assert from "node:assert/strict";
import test from "node:test";
import { fanOut, resolveChannel, type NotificationChannel } from "../src/notify/channel";
import { asciiHeader } from "../src/notify/pushChannel";

function recordingChannel(
  name: NotificationChannel["name"],
  log: string[],
  messageIds?: Record<string, string>,
): NotificationChannel {
  return {
    name,
    async notifyQuestions() {
      log.push(`${name}:questions`);
      return messageIds ? { messageIds } : {};
    },
    async notifyAnswerAccepted() {
      log.push(`${name}:answer`);
    },
    async notifyRunSummary() {
      log.push(`${name}:summary`);
    },
    async notifyBrowserBlocked() {
      log.push(`${name}:blocked`);
    },
    async notifyStuck() {
      log.push(`${name}:stuck`);
    },
  };
}

const cfg = (over: Partial<Parameters<typeof resolveChannel>[0]> = {}) => ({
  JOB_APPLY_NOTIFY_CHANNEL: "desktop" as const,
  ...over,
});

test("push is additive — the Mac notification still fires", () => {
  const log: string[] = [];
  const channel = resolveChannel(
    cfg({ JOB_APPLY_PUSH_ENABLED: true, NTFY_TOPIC: "a-long-secret-topic" }),
    {
      createDesktop: () => recordingChannel("desktop", log),
      createDashboard: () => recordingChannel("dashboard", log),
      createPush: () => recordingChannel("push", log),
    },
  );
  return channel.notifyBrowserBlocked({
    site: "indeed",
    kind: "captcha",
    message: "blocked",
  }).then(() => {
    assert.deepEqual(log, ["desktop:blocked", "push:blocked"]);
  });
});

test("a stall fans out to Mac and phone on the same ntfy channel", () => {
  const log: string[] = [];
  const channel = resolveChannel(
    cfg({ JOB_APPLY_PUSH_ENABLED: true, NTFY_TOPIC: "a-long-secret-topic" }),
    {
      createDesktop: () => recordingChannel("desktop", log),
      createDashboard: () => recordingChannel("dashboard", log),
      createPush: () => recordingChannel("push", log),
    },
  );
  return channel.notifyStuck({
    jobTitle: "Software Developer",
    company: "PERSANTE",
    kind: "stalled",
  }).then(() => {
    assert.deepEqual(log, ["desktop:stuck", "push:stuck"]);
  });
});

test("push enabled with no topic stays silent instead of erroring", () => {
  // A half-configured push would otherwise throw on every single notification.
  const log: string[] = [];
  const channel = resolveChannel(cfg({ JOB_APPLY_PUSH_ENABLED: true }), {
    createDesktop: () => recordingChannel("desktop", log),
    createDashboard: () => recordingChannel("dashboard", log),
    createPush: () => recordingChannel("push", log),
  });
  assert.equal(channel.name, "desktop");
});

test("push off leaves behaviour exactly as it was", () => {
  const log: string[] = [];
  const channel = resolveChannel(cfg({ NTFY_TOPIC: "a-long-secret-topic" }), {
    createDesktop: () => recordingChannel("desktop", log),
    createDashboard: () => recordingChannel("dashboard", log),
    createPush: () => recordingChannel("push", log),
  });
  assert.equal(channel.name, "desktop");
});

test("the dashboard keeps ownership of message ids", async () => {
  // Answering a pending question looks it up by the dashboard's id. If the push channel's
  // empty result won, replies would stop resolving.
  const log: string[] = [];
  const channel = fanOut([
    recordingChannel("dashboard", log, { q1: "dashboard-message-1" }),
    recordingChannel("push", log),
  ]);
  const result = await channel.notifyQuestions({
    jobTitle: "Senior .NET Engineer",
    company: "Acme",
    questions: [{ shortId: "q1", questionText: "Years of C#?", options: [], required: true }],
  });
  assert.deepEqual(result.messageIds, { q1: "dashboard-message-1" });
  assert.deepEqual(log, ["dashboard:questions", "push:questions"]);
});

test("header text survives a company name with non-ascii characters", () => {
  assert.equal(asciiHeader("Beyond Café — Senior Engineer"), "Beyond Caf  Senior Engineer");
  assert.equal(asciiHeader("日本"), "JobAgent", "never sends an empty header");
});
