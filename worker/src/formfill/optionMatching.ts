// Re-implemented from BroswerExtension option matching (serviceWorker + fieldFiller).
import { normalizeQuestion } from "./questionNormalizer";

export function comparableOption(value: string): string {
  return normalizeQuestion(value).replace(
    /\b(do not wish answer|prefer not say)\b/g,
    "decline",
  );
}

export function optionMatches(options: string[], answer: string): boolean {
  const targets = answer
    .split(",")
    .map((item) => normalizeQuestion(item))
    .filter(Boolean);
  return (
    targets.length > 0 &&
    targets.every((target) =>
      options.some((option) => {
        const normalized = normalizeQuestion(option);
        return (
          normalized === target ||
          normalized.includes(target) ||
          target.includes(normalized)
        );
      }),
    )
  );
}

/** Returns −1 when no option matches or more than one option is equally good. */
export function bestOptionIndex(options: string[], desired: string): number {
  if (!options.length || !desired.trim()) return -1;
  const target = comparableOption(desired);
  const exactIndexes = options
    .map((option, index) => ({ option: comparableOption(option), index }))
    .filter((item) => item.option === target)
    .map((item) => item.index);
  if (exactIndexes.length === 1) return exactIndexes[0]!;
  if (exactIndexes.length > 1) return -1;

  const fuzzy = options
    .map((option, index) => ({ option: comparableOption(option), index }))
    .filter(
      (item) =>
        item.option.includes(target) ||
        (target.length > 0 && target.includes(item.option) && item.option.length > 0),
    );
  if (fuzzy.length === 1) return fuzzy[0]!.index;
  return -1;
}
