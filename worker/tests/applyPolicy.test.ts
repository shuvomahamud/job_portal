import assert from "node:assert/strict";
import test from "node:test";
import {
  decideFieldAction,
  effectiveMode,
} from "../src/apply/applyPolicy";
import type { DetectedField, SavedAnswer } from "../src/formfill/types";
import { isBlockedFromRetry, statusAfterApplyFailure } from "../src/apply/applyRunner";
import {
  betweenApplicationsMs,
  interFieldDelayMs,
  preSubmitDelayMs,
  readingDelayMs,
  typingDelayMs,
} from "../src/apply/humanInput";
import { isExternalAts, sourceUrlAllowed } from "../src/apply/applySteps";
import {
  ELIGIBLE_ROLE_MATCH_STATUS,
  selectJobsWithinRunLimits,
} from "../src/apply/applyEligibility";

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: "f1",
    selector: "#email",
    tagName: "input",
    inputType: "email",
    labelText: "Email",
    normalizedQuestion: "email",
    placeholder: "",
    ariaLabel: "",
    name: "email",
    idAttribute: "email",
    required: true,
    options: [],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "email",
    riskLevel: "LOW",
    confidence: 0.99,
    ...overrides,
  };
}

function answer(overrides: Partial<SavedAnswer> = {}): SavedAnswer {
  return {
    id: "a1",
    normalizedQuestion: "email",
    originalQuestion: "Email",
    category: "email",
    answerValue: "a@example.com",
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

test("effectiveMode clamps requested mode to the configured ceiling", () => {
  assert.equal(effectiveMode("fill_and_submit", "dry_run"), "dry_run");
  assert.equal(effectiveMode("fill_only", "fill_and_submit"), "fill_only");
  assert.equal(effectiveMode(undefined, "fill_only"), "fill_only");
});

test("decideFieldAction skips file uploads", () => {
  const action = decideFieldAction({
    field: field({ inputType: "file", fieldCategory: "resume_upload" }),
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "skip");
});

test("decideFieldAction asks for sensitive categories without exact matches", () => {
  const action = decideFieldAction({
    field: field({
      fieldCategory: "sponsorship_required",
      riskLevel: "MEDIUM",
      labelText: "Need sponsorship?",
      normalizedQuestion: "sponsorship",
      inputType: "select",
    }),
    match: {
      fieldId: "f1",
      savedAnswerId: "a1",
      matchType: "ollama",
      confidence: 0.99,
      reason: "x",
      requiresReview: true,
    },
    savedAnswer: answer({
      category: "sponsorship_required",
      answerValue: "No",
    }),
    suggestedValue: "No",
    trustLlmAnswers: true,
  });
  assert.equal(action.kind, "ask");
});

test("candidate-authorized job salary may fill from an explicit posting range", () => {
  const action = decideFieldAction({
    field: field({
      fieldCategory: "expected_salary",
      riskLevel: "MEDIUM",
      labelText: "Expected annual salary",
      normalizedQuestion: "expected salary",
      confidence: 0.92,
    }),
    match: {
      fieldId: "f1",
      savedAnswerId: "derived:salary:expected_salary",
      matchType: "rule",
      confidence: 0.93,
      reason: "job range",
      requiresReview: true,
    },
    savedAnswer: answer({
      id: "derived:salary:expected_salary",
      category: "expected_salary",
      answerValue: "180000",
    }),
    suggestedValue: "180000",
    trustLlmAnswers: false,
  });
  assert.deepEqual(action, { kind: "fill", value: "180000", source: "rule" });
});

test("an ordinary rule-matched salary still requires a question", () => {
  const action = decideFieldAction({
    field: field({
      fieldCategory: "expected_salary",
      riskLevel: "MEDIUM",
      labelText: "Expected annual salary",
      normalizedQuestion: "expected salary",
      confidence: 0.92,
    }),
    match: {
      fieldId: "f1",
      savedAnswerId: "a1",
      matchType: "rule",
      confidence: 0.93,
      reason: "category",
      requiresReview: true,
    },
    savedAnswer: answer({ category: "expected_salary", answerValue: "180000" }),
    suggestedValue: "180000",
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "ask");
});

test("candidate-authorized contractor sponsorship answer may fill", () => {
  const action = decideFieldAction({
    field: field({
      fieldCategory: "sponsorship_required",
      riskLevel: "MEDIUM",
      labelText: "Will you require sponsorship?",
      normalizedQuestion: "sponsorship",
      inputType: "select",
      options: ["Yes", "No"],
      confidence: 0.97,
    }),
    match: {
      fieldId: "f1",
      savedAnswerId: "derived:authorization:sponsorship_required",
      matchType: "rule",
      confidence: 0.93,
      reason: "conditional profile policy",
      requiresReview: true,
    },
    savedAnswer: answer({
      id: "derived:authorization:sponsorship_required",
      category: "sponsorship_required",
      answerValue: "No",
    }),
    suggestedValue: "No",
    trustLlmAnswers: false,
  });
  assert.deepEqual(action, { kind: "fill", value: "No", source: "rule" });
});

test("decideFieldAction fills exact low-risk matches", () => {
  const action = decideFieldAction({
    field: field(),
    match: {
      fieldId: "f1",
      savedAnswerId: "a1",
      matchType: "exact",
      confidence: 0.99,
      reason: "exact",
      requiresReview: false,
    },
    savedAnswer: answer(),
    suggestedValue: "a@example.com",
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "fill");
  if (action.kind === "fill") assert.equal(action.value, "a@example.com");
});

test("decideFieldAction asks when a saved match is below the confidence threshold", () => {
  const action = decideFieldAction({
    field: field(),
    match: {
      fieldId: "f1",
      savedAnswerId: "a1",
      matchType: "normalized",
      confidence: 0.7,
      reason: "weak normalized match",
      requiresReview: true,
    },
    savedAnswer: answer(),
    suggestedValue: "a@example.com",
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "ask");
});

test("decideFieldAction asks before filling an incompatible option", () => {
  const action = decideFieldAction({
    field: field({ inputType: "select", options: ["Yes", "No"] }),
    match: {
      fieldId: "f1",
      savedAnswerId: "a1",
      matchType: "exact",
      confidence: 0.99,
      reason: "exact",
      requiresReview: false,
    },
    savedAnswer: answer({ answerValue: "Maybe" }),
    suggestedValue: "Maybe",
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "ask");
});

test("seeded human delays stay in documented ranges", () => {
  const rng = () => 0;
  assert.equal(typingDelayMs(rng), 45);
  assert.equal(interFieldDelayMs(rng), 700);
  assert.equal(preSubmitDelayMs(rng), 3000);
  assert.equal(readingDelayMs(180, rng) <= 12_000, true);
  assert.equal(betweenApplicationsMs(90, 420, rng), 90_000);
});

test("external ATS detection and source URL allow-list", () => {
  assert.equal(isExternalAts("https://boards.greenhouse.io/x", ["indeed.com"]).external, true);
  assert.equal(sourceUrlAllowed("indeed", "https://www.indeed.com/viewjob?jk=1"), true);
  assert.equal(sourceUrlAllowed("indeed", "https://linkedin.com/jobs/1"), false);
  assert.equal(sourceUrlAllowed("fixture", "file:///tmp/form.html"), true);
});

const BLOCKED_RETRY_STATUSES = new Set([
  "submitting",
  "submission_unknown",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "draft",
  "filling",
  "awaiting_answer",
]);

test("submission_unknown is not retried by a subsequent apply cycle", () => {
  assert.equal(isBlockedFromRetry("submission_unknown"), true);
  assert.equal(isBlockedFromRetry("draft"), true);
  assert.equal(isBlockedFromRetry("awaiting_answer"), true);
  assert.equal(isBlockedFromRetry("ready"), false);
  assert.equal(BLOCKED_RETRY_STATUSES.has("submission_unknown"), true);
});

test("any failure after the submitting write remains submission_unknown", () => {
  assert.equal(statusAfterApplyFailure(true), "submission_unknown");
  assert.equal(statusAfterApplyFailure(false), "needs_manual");
});

test("run selection stops at the global limit and honors per-role limits", () => {
  assert.equal(ELIGIBLE_ROLE_MATCH_STATUS, "match");
  const candidates = [
    { jobId: "job-1", targetRoleId: "role-a", roleRunLimit: 1 },
    { jobId: "job-2", targetRoleId: "role-a", roleRunLimit: 1 },
    { jobId: "job-3", targetRoleId: "role-b", roleRunLimit: null },
    { jobId: "job-4", targetRoleId: "role-b", roleRunLimit: null },
  ];
  assert.deepEqual(selectJobsWithinRunLimits(candidates, 2), ["job-1", "job-3"]);
});

test("a new run starts with a fresh allowance", () => {
  const candidates = [
    { jobId: "job-1", targetRoleId: "role-a", roleRunLimit: 1 },
    { jobId: "job-2", targetRoleId: "role-a", roleRunLimit: 1 },
  ];
  assert.deepEqual(selectJobsWithinRunLimits(candidates, 5), ["job-1"]);
  assert.deepEqual(selectJobsWithinRunLimits(candidates, 5), ["job-1"]);
});
