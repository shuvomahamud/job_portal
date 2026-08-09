// Ported from BroswerExtension/src/lib/answerMatcher.ts — keep byte-identical aside from this provenance line.
import type {
  AnswerMatch,
  DetectedField,
  ExtensionSettings,
  SavedAnswer
} from "./types";
import { normalizeQuestion, questionSimilarity } from "./questionNormalizer";
import { requiresReview } from "./riskPolicy";

function makeMatch(
  field: DetectedField,
  answer: SavedAnswer,
  matchType: AnswerMatch["matchType"],
  confidence: number,
  reason: string,
  settings?: ExtensionSettings
): AnswerMatch {
  return {
    fieldId: field.id,
    savedAnswerId: answer.id,
    matchType,
    confidence,
    reason,
    requiresReview: requiresReview(field, confidence, settings)
  };
}

export function matchSavedAnswer(
  field: DetectedField,
  answers: SavedAnswer[],
  settings?: ExtensionSettings
): AnswerMatch | undefined {
  if (!answers.length || field.inputType === "password" || field.inputType === "file") {
    return undefined;
  }

  const exact = answers.find(
    (answer) =>
      answer.normalizedQuestion === field.normalizedQuestion &&
      answer.category === field.fieldCategory
  );
  if (exact) {
    return makeMatch(
      field,
      exact,
      "exact",
      0.99,
      "Exact normalized question and category match.",
      settings
    );
  }

  const normalized = answers.find(
    (answer) => answer.normalizedQuestion === field.normalizedQuestion
  );
  if (normalized) {
    return makeMatch(
      field,
      normalized,
      "normalized",
      0.96,
      "Exact normalized question match.",
      settings
    );
  }

  for (const answer of answers) {
    if (
      answer.aliases.some(
        (alias) => normalizeQuestion(alias) === field.normalizedQuestion
      )
    ) {
      return makeMatch(
        field,
        answer,
        "alias",
        0.95,
        "A user-provided alias matches this question.",
        settings
      );
    }
  }

  const categoryCandidates = answers.filter(
    (answer) =>
      answer.category === field.fieldCategory && field.fieldCategory !== "unknown"
  );
  if (categoryCandidates.length === 1) {
    const confidence =
      field.confidence >= 0.9 &&
      !["custom_short_answer", "custom_long_answer"].includes(field.fieldCategory)
        ? 0.93
        : 0.78;
    return makeMatch(
      field,
      categoryCandidates[0],
      "rule",
      confidence,
      "A deterministic field category maps to one saved answer.",
      settings
    );
  }

  const ranked = answers
    .map((answer) => ({
      answer,
      score: questionSimilarity(
        field.normalizedQuestion,
        answer.normalizedQuestion
      )
    }))
    .filter(({ score }) => score >= 0.55)
    .sort((a, b) => b.score - a.score);

  if (ranked[0] && (!ranked[1] || ranked[0].score - ranked[1].score >= 0.12)) {
    const confidence = Math.min(0.9, 0.58 + ranked[0].score * 0.32);
    return makeMatch(
      field,
      ranked[0].answer,
      "normalized",
      confidence,
      "The normalized question tokens are similar.",
      settings
    );
  }
  return undefined;
}

export function answerNeedsOllamaMatch(
  field: DetectedField,
  answers: SavedAnswer[],
  deterministicMatch?: AnswerMatch
): boolean {
  return Boolean(
    answers.length &&
      !deterministicMatch &&
      (field.fieldCategory === "unknown" ||
        field.confidence < 0.8 ||
        answers.filter((a) => a.category === field.fieldCategory).length > 1)
  );
}
