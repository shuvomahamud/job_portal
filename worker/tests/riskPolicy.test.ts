import assert from "node:assert/strict";
import test from "node:test";
import {
  canFillSafely,
  canUseUserApprovedSafeAnswer,
  categoryAlwaysRequiresReview,
  getRiskLevel,
} from "../src/formfill/riskPolicy";
import type { MatchSettings } from "../src/formfill/types";

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

test("riskPolicy assigns expected category risk", () => {
  assert.equal(getRiskLevel("email"), "LOW");
  assert.equal(getRiskLevel("sponsorship_required"), "MEDIUM");
  assert.equal(getRiskLevel("eeo_disability"), "HIGH");
  assert.equal(getRiskLevel("remote_preference", 0.95), "LOW");
  assert.equal(getRiskLevel("email", 0.4), "HIGH");
});

test("riskPolicy never safe-fills sensitive categories", () => {
  assert.equal(categoryAlwaysRequiresReview("expected_salary"), true);
  assert.equal(categoryAlwaysRequiresReview("eeo_veteran"), true);
  assert.equal(
    canFillSafely(
      {
        fieldCategory: "sponsorship_required",
        riskLevel: "MEDIUM",
        confidence: 0.99,
      },
      0.99,
      settings,
    ),
    false,
  );
});

test("riskPolicy allows low-risk, high-confidence safe fill", () => {
  assert.equal(
    canFillSafely(
      { fieldCategory: "email", riskLevel: "LOW", confidence: 0.98 },
      0.99,
      settings,
    ),
    true,
  );
});

test("riskPolicy allows user-approved exact custom answers without weakening sensitive policy", () => {
  assert.equal(
    canUseUserApprovedSafeAnswer(
      { fieldCategory: "custom_short_answer", inputType: "text" },
      { matchType: "exact", confidence: 0.99 },
      { riskLevel: "LOW" },
      settings,
    ),
    true,
  );
  assert.equal(
    canUseUserApprovedSafeAnswer(
      { fieldCategory: "custom_short_answer", inputType: "text" },
      { matchType: "rule", confidence: 0.99 },
      { riskLevel: "LOW" },
      settings,
    ),
    false,
  );
  assert.equal(
    canUseUserApprovedSafeAnswer(
      { fieldCategory: "legal_background", inputType: "radio" },
      { matchType: "exact", confidence: 0.99 },
      { riskLevel: "LOW" },
      settings,
    ),
    false,
  );
});

test("riskPolicy batch-fills a saved gender answer only when enabled", () => {
  const field = { fieldCategory: "eeo_gender" as const, inputType: "select" };
  const match = { matchType: "rule" as const, confidence: 0.95 };
  const answer = { riskLevel: "HIGH" as const };
  assert.equal(canUseUserApprovedSafeAnswer(field, match, answer, settings), true);
  assert.equal(
    canUseUserApprovedSafeAnswer(field, match, answer, {
      ...settings,
      allowOneClickSavedGender: false,
    }),
    false,
  );
});

for (const fieldCategory of ["work_authorization", "sponsorship_required"] as const) {
  test(`riskPolicy batch-fills saved ${fieldCategory} only when work-eligibility batching is enabled`, () => {
    const field = { fieldCategory, inputType: "radio" };
    const match = { matchType: "exact" as const, confidence: 0.99 };
    const answer = { riskLevel: "MEDIUM" as const };
    assert.equal(canUseUserApprovedSafeAnswer(field, match, answer, settings), true);
    assert.equal(
      canUseUserApprovedSafeAnswer(field, match, answer, {
        ...settings,
        allowOneClickSavedWorkEligibility: false,
      }),
      false,
    );
  });
}
