import assert from "node:assert/strict";
import test from "node:test";
import { matchSavedAnswer } from "../src/formfill/answerMatcher";
import type { DetectedField, MatchSettings, SavedAnswer } from "../src/formfill/types";

const settings: MatchSettings = {
  ollamaBaseUrl: "http://localhost:11434",
  selectedModel: "llama3.1:latest",
  autoFillConfidenceThreshold: 0.88,
  allowAutoFillLowRisk: false,
  requireReviewMediumHigh: true,
  useOllamaForAmbiguous: true,
  allowOneClickSavedGender: true,
  allowOneClickSavedWorkEligibility: true,
};

function detected(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: "field-1",
    selector: "#field",
    tagName: "input",
    inputType: "text",
    labelText: "Email address",
    normalizedQuestion: "email",
    placeholder: "",
    ariaLabel: "",
    name: "email",
    idAttribute: "field",
    required: true,
    options: [],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "email",
    riskLevel: "LOW",
    confidence: 0.98,
    ...overrides,
  };
}

function saved(overrides: Partial<SavedAnswer> = {}): SavedAnswer {
  return {
    id: "answer-1",
    normalizedQuestion: "email",
    originalQuestion: "Email",
    category: "email",
    answerValue: "candidate@example.com",
    answerType: "text",
    sitePattern: "",
    domain: "",
    usageCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    riskLevel: "LOW",
    notes: "",
    aliases: [],
    ...overrides,
  };
}

test("matchSavedAnswer returns a high-confidence exact match", () => {
  const match = matchSavedAnswer(detected(), [saved()], settings);
  assert.equal(match?.matchType, "exact");
  assert.equal(match?.confidence, 0.99);
  assert.equal(match?.requiresReview, false);
});

test("matchSavedAnswer matches a user alias", () => {
  const field = detected({
    labelText: "Best contact email",
    normalizedQuestion: "email",
  });
  const answer = saved({ normalizedQuestion: "primary email", aliases: ["Best contact email"] });
  assert.equal(matchSavedAnswer(field, [answer], settings)?.matchType, "alias");
});

test("matchSavedAnswer category rules suggest a single saved answer", () => {
  const field = detected({
    labelText: "Your electronic mail",
    normalizedQuestion: "electronic mail",
  });
  assert.equal(matchSavedAnswer(field, [saved()], settings)?.matchType, "rule");
});

test("matchSavedAnswer always reviews sponsorship even with an exact match", () => {
  const field = detected({
    labelText: "Do you need sponsorship?",
    normalizedQuestion: "sponsorship required",
    fieldCategory: "sponsorship_required",
    riskLevel: "MEDIUM",
    confidence: 0.98,
  });
  const answer = saved({
    normalizedQuestion: "sponsorship required",
    category: "sponsorship_required",
    answerValue: "No",
    riskLevel: "MEDIUM",
  });
  assert.equal(matchSavedAnswer(field, [answer], settings)?.requiresReview, true);
});
