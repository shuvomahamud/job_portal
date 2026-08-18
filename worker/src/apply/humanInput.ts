/** Typing and inter-field pacing — injectable rng for deterministic tests. */

/**
 * Pacing exists for two different reasons, and only one of them survives being cut.
 *
 * The delays *around* the form — idling between applications, dawdling between pages —
 * bought nothing: challenges kept appearing anyway, and they cost hours per run. Those
 * are gone.
 *
 * The delays *inside* a form still earn their place: real application forms debounce
 * validation, populate dropdowns asynchronously, and run autocomplete on keystrokes.
 * Instant typing makes a field look filled while the page never registers the value.
 * They are also kept a little slower than a machine burst so the apply reads as a
 * person filling a form, without going back to the old multi-second page stares.
 */

export function typingDelayMs(random = Math.random): number {
  return Math.round(40 + random() * (90 - 40));
}

export function punctuationPauseMs(char: string, random = Math.random): number {
  if (!". ,?!".includes(char)) return 0;
  return Math.round(220 + random() * (450 - 220));
}

/** Enough for a debounced validator or async dropdown to fire, with a short human beat. */
export function interFieldDelayMs(random = Math.random): number {
  return Math.round(450 + random() * (900 - 450));
}

export function readingDelayMs(wordCount: number, random = Math.random): number {
  const wpm = 160;
  const ms = Math.round((wordCount / wpm) * 60_000 * (0.85 + random() * 0.3));
  return Math.min(4_000, Math.max(400, ms));
}

/** A beat before the irreversible click, so late validation can surface first. */
export function preSubmitDelayMs(random = Math.random): number {
  return Math.round(1200 + random() * (2200 - 1200));
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
