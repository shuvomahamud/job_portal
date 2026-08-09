import { matchSavedAnswer } from "./answerMatcher";
import type {
  DetectedField,
  FieldSuggestion,
  MatchSettings,
  SavedAnswer,
} from "./types";

/**
 * Lightweight suggestion builder. Ollama enhancement is capped and optional;
 * the apply runner can call enhanceFieldsWithOllama separately when configured.
 */
export function buildSuggestion(
  field: DetectedField,
  answers: SavedAnswer[],
  settings?: MatchSettings,
): FieldSuggestion {
  const match = matchSavedAnswer(field, answers, settings);
  const savedAnswer = match
    ? answers.find((answer) => answer.id === match.savedAnswerId)
    : undefined;
  return {
    field,
    match,
    savedAnswer,
    suggestedValue: savedAnswer?.answerValue ?? "",
    source: match?.matchType ?? "none",
    requiresReview: match?.requiresReview ?? true,
  };
}

/** Stage-8 stub: skip LLM enhancement unless a provider is injected later. */
export async function enhanceFieldsWithOllama(
  fields: DetectedField[],
  _settings?: MatchSettings,
  options?: { maxCalls?: number; minConfidence?: number },
): Promise<{ fields: DetectedField[]; available: boolean; calls: number }> {
  void options;
  return { fields, available: false, calls: 0 };
}
