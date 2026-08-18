import assert from "node:assert/strict";
import test from "node:test";
import { waitForHumanChallenge, waitForPendingAnswers } from "../src/apply/waitForHumanChallenge";
import type { BrowserBlocker } from "../src/browser/blockerDetection";

const captcha = (evidence = "visible"): BrowserBlocker => ({
  kind: "captcha",
  site: "indeed",
  pageUrl: "https://smartapply.indeed.com/submit",
  message: "indeed needs a CAPTCHA solved.",
  evidence,
});

test("pauses until Resume, even if the checkbox disappears first", async () => {
  let paused = false;
  let challenge: BrowserBlocker | null = captcha();
  const asks: string[] = [];
  let cleared = 0;
  const ticks: Array<"poll" | "resume" | "gone"> = ["poll", "gone", "poll", "resume"];

  const result = await waitForHumanChallenge({
    initial: captcha(),
    detect: async () => challenge,
    isPaused: async () => paused,
    setPaused: async (value) => {
      paused = value;
    },
    onAsk: async (blocker) => {
      asks.push(blocker.kind);
    },
    onCleared: async () => {
      cleared += 1;
    },
    sleep: async () => {
      const tick = ticks.shift();
      if (tick === "gone") challenge = null;
      if (tick === "resume") paused = false;
    },
    pollMs: 1,
  });

  assert.equal(result, "cleared");
  assert.equal(asks.length, 1);
  assert.equal(cleared, 1);
  assert.equal(paused, false);
});

test("Resume continues even if the challenge is still up", async () => {
  let paused = false;
  let challenge: BrowserBlocker | null = captcha();
  const asks: string[] = [];

  const result = await waitForHumanChallenge({
    initial: captcha(),
    detect: async () => challenge,
    isPaused: async () => paused,
    setPaused: async (value) => {
      paused = value;
    },
    onAsk: async (blocker) => {
      asks.push(blocker.kind);
    },
    sleep: async () => {
      paused = false;
    },
    pollMs: 1,
  });

  assert.equal(result, "cleared");
  assert.equal(asks.length, 1, "Resume must not immediately re-ask while the widget is still visible");
  assert.equal(challenge?.kind, "captcha");
});

test("clearing the alert without Resume keeps waiting", async () => {
  let paused = false;
  let alertOpen = true;
  let challenge: BrowserBlocker | null = captcha();
  let cleared = 0;
  const ticks: Array<"handled" | "poll" | "resume"> = ["handled", "poll", "resume"];

  const result = await waitForHumanChallenge({
    initial: captcha(),
    detect: async () => challenge,
    isPaused: async () => paused,
    setPaused: async (value) => {
      paused = value;
    },
    alertStillOpen: async () => alertOpen,
    onAsk: async () => {},
    onCleared: async () => {
      cleared += 1;
    },
    sleep: async () => {
      const tick = ticks.shift();
      if (tick === "handled") {
        alertOpen = false;
        challenge = null;
      }
      if (tick === "resume") paused = false;
    },
    pollMs: 1,
  });

  assert.equal(result, "cleared");
  assert.equal(cleared, 1);
  assert.deepEqual(ticks, []);
});

test("aborts when the command is halted", async () => {
  let halted = false;
  const result = await waitForHumanChallenge({
    initial: captcha(),
    detect: async () => captcha(),
    isPaused: async () => true,
    setPaused: async () => {},
    onAsk: async () => {},
    shouldHalt: async () => halted,
    sleep: async () => {
      halted = true;
    },
    pollMs: 1,
  });
  assert.equal(result, "aborted");
});

test("question wait does not continue just because the page was answered", async () => {
  let paused = false;
  let open = true;
  const ticks: Array<"answered" | "poll" | "resume"> = ["answered", "poll", "resume"];
  const result = await waitForPendingAnswers({
    hasOpenQuestions: async () => open,
    isPaused: async () => paused,
    setPaused: async (value) => {
      paused = value;
    },
    sleep: async () => {
      const tick = ticks.shift();
      if (tick === "answered") open = false;
      if (tick === "resume") paused = false;
    },
    pollMs: 1,
  });
  assert.equal(result, "resumed");
  assert.equal(open, false, "questions can be gone while we still wait for Resume");
  assert.deepEqual(ticks, []);
});

test("question wait treats Resume as continue even if questions remain", async () => {
  let paused = false;
  const result = await waitForPendingAnswers({
    hasOpenQuestions: async () => true,
    isPaused: async () => paused,
    setPaused: async (value) => {
      paused = value;
    },
    sleep: async () => {
      paused = false;
    },
    pollMs: 1,
  });
  assert.equal(result, "resumed");
});
