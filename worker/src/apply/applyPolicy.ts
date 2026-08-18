import {
  categoryAlwaysRequiresReview,
  getRiskLevel,
} from "../formfill/riskPolicy";
import { bestOptionIndex, optionMatches } from "../formfill/optionMatching";
import type {
  AnswerMatch,
  DetectedField,
  MatchType,
  SavedAnswer,
} from "../formfill/types";
import { isHistoricalResumeLocationField } from "./resumeCards";
import { computedAnswerFor } from "../formfill/computedAnswers";

export type ApplyMode = "dry_run" | "fill_only" | "fill_and_submit";

export const APPLY_MODE_RANK: Record<ApplyMode, number> = {
  dry_run: 0,
  fill_only: 1,
  fill_and_submit: 2,
};

export function effectiveMode(
  requested: ApplyMode | undefined,
  ceiling: ApplyMode,
): ApplyMode {
  const want = requested ?? ceiling;
  return APPLY_MODE_RANK[want] <= APPLY_MODE_RANK[ceiling] ? want : ceiling;
}

export type FieldAction =
  | { kind: "fill"; value: string; source: MatchType | "profile" }
  | { kind: "ask"; reason: string }
  | { kind: "skip"; reason: string };

export type DecideFieldInput = {
  field: DetectedField;
  match?: AnswerMatch;
  savedAnswer?: SavedAnswer;
  suggestedValue?: string;
  trustLlmAnswers: boolean;
  dropdownMapped?: boolean;
};

export function fieldQuestionText(
  field: Pick<DetectedField, "labelText" | "normalizedQuestion" | "nearbyText">,
): string {
  return `${field.labelText} ${field.normalizedQuestion} ${field.nearbyText}`.toLowerCase();
}

export function isMarketingOptInField(
  field: Pick<DetectedField, "labelText" | "normalizedQuestion" | "nearbyText">,
): boolean {
  const text = fieldQuestionText(field);
  return (
    /\bopt[\s-]?in\b/.test(text) ||
    (/\bemail notifications?\b/.test(text) &&
      /\b(receive|new jobs|marketing|subscribe)\b/.test(text))
  );
}

export function isInstructionalDisclaimerField(
  field: Pick<DetectedField, "labelText" | "inputType">,
): boolean {
  const text = field.labelText.replace(/\s+/g, " ").trim();
  if (text.length < 160) return false;
  return /strict confidence|asterisks?\*? are required|complete all portions of this application|we request the following information/i.test(
    text,
  );
}

function yesNoOption(options: string[], want: "yes" | "no"): string | undefined {
  const re = want === "no" ? /^(no|false|decline)\b/i : /^(yes|true)\b/i;
  return options.find((option) => re.test(option.trim()));
}

function matchingOption(options: string[], value: string): string | undefined {
  if (!options.length || !value.trim()) return undefined;
  const index = bestOptionIndex(options, value);
  if (index >= 0) return options[index];
  const lead = /^(yes|no)\b/i.exec(value.trim());
  if (lead) return yesNoOption(options, lead[1]!.toLowerCase() as "yes" | "no");
  return undefined;
}

export function isAcknowledgmentField(
  field: Pick<DetectedField, "labelText" | "options" | "inputType">,
): boolean {
  if (!["radio", "checkbox"].includes(field.inputType)) return false;
  if (field.options.length === 1 && /i (understand|agree|acknowledge|accept)\b/i.test(field.options[0] ?? "")) {
    return true;
  }
  return (
    field.options.length <= 1 &&
    /\b(privacy policy|terms of service|i agree|i understand|i acknowledge)\b/i.test(field.labelText)
  );
}

export function isSmsOptInField(
  field: Pick<DetectedField, "labelText" | "normalizedQuestion" | "nearbyText" | "options">,
): boolean {
  const text = fieldQuestionText(field);
  if (!/\b(text message|sms|applicant communication)\b/.test(text)) return false;
  return field.options.some((option) => /do not agree|no,?\s*i do not/i.test(option));
}

export function isPreferredContactField(
  field: Pick<DetectedField, "labelText" | "options">,
): boolean {
  return (
    /preferred method of contact/i.test(field.labelText) &&
    field.options.some((option) => /^email$/i.test(option.trim()))
  );
}

export function decideFieldAction(input: DecideFieldInput): FieldAction {
  const { field, match, savedAnswer, suggestedValue, trustLlmAnswers, dropdownMapped } =
    input;

  if (field.inputType === "file" || field.fieldCategory === "resume_upload") {
    return { kind: "skip", reason: "Resume upload is handled separately." };
  }

  if (isInstructionalDisclaimerField(field)) {
    if (field.inputType === "checkbox") {
      return { kind: "fill", value: "true", source: "rule" };
    }
    return { kind: "skip", reason: "Instructional disclaimer, not an answer field." };
  }

  if (isMarketingOptInField(field)) {
    const chosen =
      matchingOption(field.options, suggestedValue ?? savedAnswer?.answerValue ?? "") ??
      yesNoOption(field.options, "no") ??
      "No";
    return { kind: "fill", value: chosen, source: "rule" };
  }

  if (isSmsOptInField(field)) {
    const decline =
      field.options.find((option) => /do not agree|no,?\s*i do not/i.test(option)) ??
      yesNoOption(field.options, "no");
    if (decline) return { kind: "fill", value: decline, source: "rule" };
  }

  if (isAcknowledgmentField(field)) {
    const option = field.options[0] ?? "I understand";
    return { kind: "fill", value: option, source: "rule" };
  }

  if (isPreferredContactField(field)) {
    const email = field.options.find((option) => /^email$/i.test(option.trim()));
    if (email) return { kind: "fill", value: email, source: "rule" };
  }

  if (!suggestedValue && !savedAnswer?.answerValue) {
    const computed = computedAnswerFor(field);
    if (computed) return { kind: "fill", value: computed.value, source: "rule" };
  }

  const value = suggestedValue ?? savedAnswer?.answerValue;
  const matchType = match?.matchType;
  const matchConfidence = match?.confidence ?? 0;
  const strongBank =
    Boolean(value) &&
    Boolean(matchType) &&
    ["exact", "normalized", "alias", "retrieved"].includes(matchType!) &&
    matchConfidence >= 0.9;

  if (field.options.length && value && !optionMatches(field.options, value)) {
    const coerced = matchingOption(field.options, value);
    if (coerced) {
      return { kind: "fill", value: coerced, source: matchType ?? "rule" };
    }
    if (
      /type of work (are you )?looking for/i.test(field.labelText) &&
      /^(either|both|any)\b/i.test(value.trim())
    ) {
      const fullTime = field.options.find((option) => /full[\s-]?time/i.test(option));
      if (fullTime) return { kind: "fill", value: fullTime, source: "rule" };
    }
    if (dropdownMapped && suggestedValue) {
      return { kind: "fill", value: suggestedValue, source: matchType ?? "rule" };
    }
    return { kind: "ask", reason: "Answer does not match available options." };
  }

  if (isHistoricalResumeLocationField(field)) {
    const specific =
      Boolean(value) &&
      matchType &&
      ["exact", "normalized", "alias"].includes(matchType) &&
      !savedAnswer?.id.startsWith("profile:");
    if (specific && value && matchType) {
      return { kind: "fill", value, source: matchType };
    }
    return {
      kind: "ask",
      reason:
        "Historical job/education location requires a saved answer; the current profile address is not used.",
    };
  }

  const isAuthorizedJobSalary =
    savedAnswer?.id.startsWith("derived:salary:") &&
    ["expected_salary", "desired_rate"].includes(field.fieldCategory);
  if (
    isAuthorizedJobSalary &&
    value &&
    matchType &&
    ["exact", "normalized", "alias", "rule"].includes(matchType) &&
    matchConfidence >= 0.9 &&
    field.confidence >= 0.7
  ) {
    return { kind: "fill", value, source: matchType };
  }

  const isAuthorizedConditionalWorkAnswer =
    savedAnswer?.id.startsWith("derived:authorization:") &&
    ["work_authorization", "sponsorship_required"].includes(field.fieldCategory);
  if (
    isAuthorizedConditionalWorkAnswer &&
    value &&
    matchType &&
    ["exact", "normalized", "alias", "rule"].includes(matchType) &&
    matchConfidence >= 0.9 &&
    field.confidence >= 0.7
  ) {
    return { kind: "fill", value, source: matchType };
  }

  if (categoryAlwaysRequiresReview(field.fieldCategory)) {
    if (strongBank && matchType && matchType !== "retrieved") {
      return { kind: "fill", value: value!, source: matchType };
    }
    if (strongBank && field.fieldCategory === "custom_long_answer" && matchType) {
      return { kind: "fill", value: value!, source: matchType };
    }
    return {
      kind: "ask",
      reason: `Sensitive category ${field.fieldCategory} requires an exact saved answer.`,
    };
  }

  if (strongBank && matchType) {
    return { kind: "fill", value: value!, source: matchType };
  }

  if (value && matchType === "rule") {
    const risk = field.riskLevel || getRiskLevel(field.fieldCategory, field.confidence);
    if (risk === "LOW") return { kind: "fill", value, source: "rule" };
    return { kind: "ask", reason: "Rule match on non-low-risk field." };
  }

  if (matchType === "ollama") {
    if (
      trustLlmAnswers &&
      field.fieldCategory === "custom_short_answer" &&
      value
    ) {
      return { kind: "fill", value, source: "ollama" };
    }
    return { kind: "ask", reason: "LLM match is not trusted for auto-fill." };
  }

  if (savedAnswer?.id.startsWith("profile:") && value) {
    return { kind: "fill", value, source: "profile" };
  }

  if (value && matchType) {
    return { kind: "ask", reason: "Saved answer did not meet the confidence threshold." };
  }

  if (field.required) {
    return { kind: "ask", reason: "Required field has no confident answer." };
  }

  return { kind: "skip", reason: "Optional field with no answer." };
}
