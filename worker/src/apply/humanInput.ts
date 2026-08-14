/** Typing and inter-field pacing — injectable rng for deterministic tests. */

/**
 * Pacing exists for two different reasons, and only one of them survives being cut.
 *
 * The delays *around* the form — idling between applications, dawdling between pages —
 * bought nothing: challenges kept appearing anyway, and they cost hours per run. Those
 * are gone.
 *
 * The delays *inside* a form still earn their place, for a reason that has nothing to do
 * with looking human: real application forms debounce validation, populate dropdowns
 * asynchronously, and run autocomplete on keystrokes. Typing into them instantly makes a
 * field look filled while the page never registers the value — and a form that submits
 * with silently empty fields is far worse than a slow one. So these are trimmed to the
 * smallest interval that still lets a page react, not removed.
 */

export function typingDelayMs(random = Math.random): number {
  return Math.round(15 + random() * (45 - 15));
}

export function punctuationPauseMs(char: string, random = Math.random): number {
  if (!". ,?!".includes(char)) return 0;
  return Math.round(180 + random() * (400 - 180));
}

/** Enough for a debounced validator or async dropdown to fire; no longer a pause. */
export function interFieldDelayMs(random = Math.random): number {
  return Math.round(200 + random() * (600 - 200));
}

export function readingDelayMs(wordCount: number, random = Math.random): number {
  const wpm = 180;
  const ms = Math.round((wordCount / wpm) * 60_000 * (0.85 + random() * 0.3));
  // Capped far lower: this was up to 12s of staring at a page per step.
  return Math.min(2_500, Math.max(250, ms));
}

/** A beat before the irreversible click, so late validation can surface first. */
export function preSubmitDelayMs(random = Math.random): number {
  return Math.round(800 + random() * (2000 - 800));
}

export function betweenApplicationsMs(
  minSeconds: number,
  maxSeconds: number,
  random = Math.random,
): number {
  const min = Math.max(0, minSeconds) * 1000;
  const max = Math.max(min, maxSeconds * 1000);
  return Math.round(min + random() * (max - min));
}

export type HumanTyping = {
  typingDelayMs: () => number;
};

export function createHumanTyping(random = Math.random): HumanTyping {
  return {
    typingDelayMs: () => {
      // pressSequentially uses a single delay; fold punctuation into average character delay.
      return typingDelayMs(random) + Math.round(punctuationPauseMs(".", random) / 8);
    },
  };
}
