import assert from "node:assert/strict";
import test from "node:test";
import {
  formatQuestionsBody,
  formatQuestionsTitle,
  type NotifyQuestionsInput,
} from "../src/notify/channel";
import { createDesktopChannel, DESKTOP_NOTIFY_PREFIX } from "../src/notify/desktopChannel";

const input = (count: number): NotifyQuestionsInput => ({
  jobTitle: "Senior .NET Developer",
  company: "Acme",
  questions: Array.from({ length: count }, (_, index) => ({
    shortId: `q${index}`,
    questionText: `Question ${index}`,
    options: [],
    required: index === 0,
  })),
});

/** Collects everything the channel writes to stdout while `run` is in flight. */
async function captureStdout(run: () => Promise<unknown>): Promise<string[]> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith(DESKTOP_NOTIFY_PREFIX));
}

test("one application with several gaps produces a single notification", async () => {
  const channel = createDesktopChannel();
  const lines = await captureStdout(() => channel.notifyQuestions(input(4)));

  assert.equal(lines.length, 1, "four unanswered fields must not raise four notifications");
  const payload = JSON.parse(lines[0]!.slice(DESKTOP_NOTIFY_PREFIX.length)) as {
    title: string;
    body: string;
  };
  assert.equal(payload.title, "An application needs 4 answers");
  assert.match(payload.body, /Senior \.NET Developer at Acme/);
  assert.equal(payload.body.split("\n").filter((line) => line.startsWith("•")).length, 4);
});

test("an empty batch emits nothing at all", async () => {
  const channel = createDesktopChannel();
  const lines = await captureStdout(() =>
    channel.notifyQuestions({ jobTitle: "T", company: "C", questions: [] }),
  );
  assert.deepEqual(lines, []);
});

test("a single question keeps the original singular wording", () => {
  assert.equal(formatQuestionsTitle(input(1)), "An application needs an answer");
  const optional: NotifyQuestionsInput = {
    jobTitle: "T",
    company: "C",
    questions: [{ shortId: "q", questionText: "Why us?", options: [], required: false }],
  };
  assert.equal(formatQuestionsTitle(optional), "An application has a question");
});

test("required questions are marked in the body", () => {
  const body = formatQuestionsBody(input(2));
  assert.match(body, /• Question 0 \(required\)/);
  assert.match(body, /• Question 1$/m);
});
