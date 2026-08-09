/** Typing and inter-field pacing — injectable rng for deterministic tests. */

export function typingDelayMs(random = Math.random): number {
  return Math.round(45 + random() * (140 - 45));
}

export function punctuationPauseMs(char: string, random = Math.random): number {
  if (!". ,?!".includes(char)) return 0;
  return Math.round(180 + random() * (400 - 180));
}

export function interFieldDelayMs(random = Math.random): number {
  return Math.round(700 + random() * (2600 - 700));
}

export function readingDelayMs(wordCount: number, random = Math.random): number {
  const wpm = 180;
  const ms = Math.round((wordCount / wpm) * 60_000 * (0.85 + random() * 0.3));
  return Math.min(12_000, Math.max(400, ms));
}

export function preSubmitDelayMs(random = Math.random): number {
  return Math.round(3000 + random() * (9000 - 3000));
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
