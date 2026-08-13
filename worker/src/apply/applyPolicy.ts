import {
  categoryAlwaysRequiresReview,
  getRiskLevel,
} from "../formfill/riskPolicy";
import { optionMatches } from "../formfill/optionMatching";
import type {
  AnswerMatch,
  DetectedField,
  MatchType,
  SavedAnswer,
} from "../formfill/types";

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

export function decideFieldAction(input: DecideFieldInput): FieldAction {
  const { field, match, savedAnswer, suggestedValue, trustLlmAnswers, dropdownMapped } =
    input;

  if (field.inputType === "file" || field.fieldCategory === "resume_upload") {
    return { kind: "skip", reason: "Resume upload is handled separately." };
  }

  const value = suggestedValue ?? savedAnswer?.answerValue;
  const matchType = match?.matchType;
  const matchConfidence = match?.confidence ?? 0;

  if (field.options.length && value && !optionMatches(field.options, value)) {
    if (dropdownMapped && suggestedValue) {
      return { kind: "fill", value: suggestedValue, source: matchType ?? "rule" };
    }
    return { kind: "ask", reason: "Answer does not match available options." };
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
    if (
      value &&
      matchType &&
      ["exact", "normalized", "alias"].includes(matchType)
    ) {
      return { kind: "fill", value, source: matchType };
    }
    return {
      kind: "ask",
      reason: `Sensitive category ${field.fieldCategory} requires an exact saved answer.`,
    };
  }

  if (
    value &&
    matchType &&
    ["exact", "normalized", "alias"].includes(matchType) &&
    matchConfidence >= 0.9 &&
    field.confidence >= 0.7
  ) {
    return { kind: "fill", value, source: matchType };
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
