import { bestOptionIndex } from "./optionMatching";

export type AnswerableQuestion = {
  answerType: string;
  category: string;
  options: unknown[];
  required: boolean;
};

function stringOptions(options: unknown[]): string[] {
  return options.map((option) => String(option ?? "").trim()).filter(Boolean);
}

export function resolveNumberedOptionReply(options: unknown[], raw: string): string | null {
  const values = stringOptions(options);
  if (values.length <= 8) return null;
  const match = /^\s*(\d+)\s*$/.exec(raw);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < values.length ? values[index]! : null;
}

function isYesNoOptions(options: string[]): boolean {
  if (options.length < 2 || options.length > 4) return false;
  const normalized = options.map((option) => option.toLowerCase());
  const hasYes = normalized.some((option) => /^(yes|y|true|1)\b/.test(option) || option === "yes");
  const hasNo = normalized.some((option) => /^(no|n|false|0)\b/.test(option) || option === "no");
  return hasYes && hasNo;
}

function mapYesNo(raw: string, options: string[]): string | null {
  const value = raw.trim().toLowerCase();
  const affirmative = /^(y|yes|1|true)$/.test(value);
  const negative = /^(n|no|0|false)$/.test(value);
  if (!affirmative && !negative) return null;
  const index = options.findIndex((option) => {
    const normalized = option.toLowerCase();
    return affirmative
      ? /^(yes|y)\b/.test(normalized) || normalized.includes("yes")
      : /^(no|n)\b/.test(normalized) || normalized === "no";
  });
  return index >= 0 ? options[index]! : null;
}

export function validateAnswerForQuestion(
  question: AnswerableQuestion,
  raw: string,
): { ok: true; value: string; optionValue?: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    if (question.required) return { ok: false, message: "An answer is required." };
    return { ok: false, message: "Empty answers are not accepted." };
  }

  const options = stringOptions(question.options);

  if (options.length) {
    if (isYesNoOptions(options)) {
      const mapped = mapYesNo(trimmed, options);
      if (mapped) return { ok: true, value: mapped, optionValue: mapped };
    }
    const index = bestOptionIndex(options, trimmed);
    if (index < 0) {
      return {
        ok: false,
        message: `Choose one of: ${options.join(", ")}`,
      };
    }
    const value = options[index]!;
    return { ok: true, value, optionValue: value };
  }

  if (question.category.startsWith("years_")) {
    if (!/^\d{1,2}$/.test(trimmed)) {
      return { ok: false, message: "Enter an integer number of years between 0 and 60." };
    }
    const years = Number(trimmed);
    if (years < 0 || years > 60) {
      return { ok: false, message: "Enter an integer number of years between 0 and 60." };
    }
    return { ok: true, value: String(years) };
  }

  if (trimmed.length > 5000) {
    return { ok: false, message: "Answers must be 5000 characters or fewer." };
  }

  return { ok: true, value: trimmed };
}
