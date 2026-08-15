import type { BrowserBlocker, BrowserBlockerKind } from "../browser/blockerDetection";
import { challengeNeedsHuman } from "../browser/blockerDetection";

export type HumanChallengeWait = "cleared" | "aborted";

/**
 * Stops clicking, asks for help, and stays on the current page until the user resumes.
 *
 * Indeed's "I'm not a robot" checkbox appears after Submit. Exiting the apply as `blocked`
 * abandons that page; the next run has to start over. Waiting in place keeps the form,
 * including a submit that is already in flight.
 *
 * Resume is explicit: disappearing the checkbox is not enough. The user clicks Resume
 * automated apply (or marks the alert handled). If they resume while the challenge is
 * still up, this pauses again.
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
  const solvable = input.isSolvable ?? challengeNeedsHuman;
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

    const paused = await input.isPaused();
    const alertOpen = input.alertStillOpen ? await input.alertStillOpen() : true;
    if (paused && alertOpen) {
      await sleepFn(pollMs);
      continue;
    }

    askedThisPause = false;
    if (paused) await input.setPaused(false);

    const still = await input.detect();
    if (still && solvable(still.kind)) {
      await enterPause(still);
      continue;
    }

    await input.onCleared?.();
    return "cleared";
  }
}
