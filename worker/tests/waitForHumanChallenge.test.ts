import assert from "node:assert/strict";
import test from "node:test";
import { waitForHumanChallenge } from "../src/apply/waitForHumanChallenge";
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

test("asks again if Resume is clicked while the challenge is still up", async () => {
  let paused = false;
  let challenge: BrowserBlocker | null = captcha();
  const asks: string[] = [];
  const ticks: Array<"early-resume" | "gone" | "resume"> = [
    "early-resume",
    "gone",
    "resume",
  ];

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
      const tick = ticks.shift();
      if (tick === "early-resume") paused = false;
      if (tick === "gone") challenge = null;
      if (tick === "resume") paused = false;
    },
    pollMs: 1,
  });

  assert.equal(result, "cleared");
  assert.equal(asks.length, 2, "an early resume must ask for help again");
});

test("treats clearing the alert as resume, then continues once the challenge is gone", async () => {
  let paused = false;
  let alertOpen = true;
  let challenge: BrowserBlocker | null = captcha();
  let cleared = 0;
  const ticks: Array<"handled" | "gone"> = ["handled", "gone"];

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
    },
    pollMs: 1,
  });

  assert.equal(result, "cleared");
  assert.equal(paused, false, "I've handled it must unpause so the apply loop does not abort");
  assert.equal(cleared, 1);
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
