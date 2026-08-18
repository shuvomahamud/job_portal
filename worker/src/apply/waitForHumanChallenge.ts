import type { BrowserBlocker, BrowserBlockerKind } from "../browser/blockerDetection";

export type HumanChallengeWait = "cleared" | "aborted";
export type PendingAnswersWait = "resumed" | "aborted";

/**
 * Holds the open apply tab until the user hits Resume.
 *
 * Filling the Indeed page, answering in the dashboard, or the pending-question rows
 * disappearing is not a continue signal. The last live run kept the Resume banner up
 * while the worker unpaused on its own and started filling — then crashed.
 */
export async function waitForPendingAnswers(input: {
  hasOpenQuestions?: () => Promise<boolean>;
  isPaused: () => Promise<boolean>;
  setPaused: (paused: boolean) => Promise<void>;
  shouldHalt?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<PendingAnswersWait> {
  const sleepFn = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = input.pollMs ?? 2_000;
  await input.setPaused(true);

  while (true) {
    if (input.shouldHalt && (await input.shouldHalt())) return "aborted";
    if (!(await input.isPaused())) return "resumed";
    await sleepFn(pollMs);
  }
}

/**
 * Stops clicking, asks for help, and stays on the current page until Resume.
 *
 * Indeed's "I'm not a robot" checkbox appears after Submit. Exiting the apply as `blocked`
 * abandons that page; the next run has to start over. Waiting in place keeps the form,
 * including a submit that is already in flight.
 *
 * The only continue signal is Resume (applyPaused becoming false). Signing in, solving
 * the CAPTCHA, clearing the alert, or the widget disappearing must not unpause. After
 * Resume this waiter returns even if the challenge is still visible — later steps can
 * re-detect; this one must not immediately pause again.
 *
 * Indeed also shows an image grid ("Select all images with cars") on the last review
 * page, inside a reCAPTCHA iframe the page body never exposes. Detection must see that
 * widget; this waiter then holds the tab instead of burning the remaining steps.
 */
export async function waitForHumanChallenge(input: {
  initial: BrowserBlocker;
  detect: () => Promise<BrowserBlocker | null>;
  isPaused: () => Promise<boolean>;
  setPaused: (paused: boolean) => Promise<void>;
  onAsk: (blocker: BrowserBlocker) => Promise<void>;
  onCleared?: () => Promise<void>;
  alertStillOpen?: () => Promise<boolean>;
  shouldHalt?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  isSolvable?: (kind: BrowserBlockerKind) => boolean;
}): Promise<HumanChallengeWait> {
  const sleepFn = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = input.pollMs ?? 2_000;
  let askedThisPause = false;

  const enterPause = async (blocker: BrowserBlocker) => {
    await input.setPaused(true);
    if (askedThisPause) return;
    askedThisPause = true;
    await input.onAsk(blocker);
  };

  await enterPause(input.initial);

  while (true) {
    if (input.shouldHalt && (await input.shouldHalt())) return "aborted";
    if (!(await input.isPaused())) {
      await input.onCleared?.();
      return "cleared";
    }
    await sleepFn(pollMs);
  }
}
