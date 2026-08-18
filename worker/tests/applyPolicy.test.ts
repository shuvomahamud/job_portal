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

test("a profile city must not fill a historical resume-card location", () => {
  const action = decideFieldAction({
    field: field({
      fieldCategory: "city",
      labelText: "Location for Senior Software Engineer FiftyTwo Digital",
      normalizedQuestion: "location senior software engineer fiftytwo digital",
      nearbyText: "work FiftyTwo Digital",
      confidence: 0.93,
    }),
    match: {
      fieldId: "f1",
      savedAnswerId: "profile:city",
      matchType: "rule",
      confidence: 0.93,
      reason: "category",
      requiresReview: false,
    },
    savedAnswer: answer({
      id: "profile:city",
      category: "city",
      answerValue: "South Richmond Hill",
    }),
    suggestedValue: "South Richmond Hill",
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "ask");
});

test("a saved answer for that specific resume entry may fill", () => {
  const action = decideFieldAction({
    field: field({
      fieldCategory: "city",
      labelText: "Location for Senior Software Engineer FiftyTwo Digital",
      normalizedQuestion: "location senior software engineer fiftytwo digital",
      nearbyText: "work FiftyTwo Digital",
      confidence: 0.93,
    }),
    match: {
      fieldId: "f1",
      savedAnswerId: "a-fiftytwo",
      matchType: "exact",
      confidence: 0.99,
      reason: "exact",
      requiresReview: false,
    },
    savedAnswer: answer({
      id: "a-fiftytwo",
      category: "city",
      answerValue: "Remote",
      normalizedQuestion: "location senior software engineer fiftytwo digital",
    }),
    suggestedValue: "Remote",
    trustLlmAnswers: false,
  });
  assert.deepEqual(action, { kind: "fill", value: "Remote", source: "exact" });
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
  assert.equal(typingDelayMs(rng), 40);
  assert.equal(interFieldDelayMs(rng), 450);
  assert.equal(preSubmitDelayMs(rng), 1200);
  assert.equal(readingDelayMs(180, rng) <= 4_000, true);
  assert.equal(betweenApplicationsMs(15, 45, rng), 15_000);
});

test("in-form pacing still leaves a page time to react", () => {
  const fastest = () => 0;
  assert.ok(interFieldDelayMs(fastest) >= 400, "a field always gets a moment to settle");
  assert.ok(readingDelayMs(1, fastest) >= 400, "a page always gets a moment to settle");
  assert.ok(preSubmitDelayMs(fastest) >= 1000, "late validation can surface before submit");
});

// The apply phase and its backoff are gone: nothing waits for scoring to finish, because
// the applier asks the database what is eligible rather than being handed a list.

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

test("run selection stops at the limit chosen for this run", () => {
  assert.equal(ELIGIBLE_ROLE_MATCH_STATUS, "match");
  const candidates = [
    { jobId: "job-1", targetRoleId: "role-a", roleRunLimit: 1 },
    { jobId: "job-2", targetRoleId: "role-a", roleRunLimit: 1 },
    { jobId: "job-3", targetRoleId: "role-b", roleRunLimit: null },
    { jobId: "job-4", targetRoleId: "role-b", roleRunLimit: null },
  ];
  assert.deepEqual(selectJobsWithinRunLimits(candidates, 2), ["job-1", "job-2"]);
});

test("a new run starts with a fresh allowance", () => {
  const candidates = [
    { jobId: "job-1", targetRoleId: "role-a", roleRunLimit: 1 },
    { jobId: "job-2", targetRoleId: "role-a", roleRunLimit: 1 },
  ];
  assert.deepEqual(selectJobsWithinRunLimits(candidates, 5), ["job-1", "job-2"]);
  assert.deepEqual(selectJobsWithinRunLimits(candidates, 5), ["job-1", "job-2"]);
});

test("marketing email opt-in fills No even when the bank suggested an email address", () => {
  const action = decideFieldAction({
    field: field({
      inputType: "radio",
      labelText:
        "Would you like to opt-in to receive email notifications about new jobs from Thomas and Company?",
      normalizedQuestion: "opt in receive email notifications new jobs",
      fieldCategory: "custom_short_answer",
      riskLevel: "MEDIUM",
      options: ["Yes", "No"],
      confidence: 0.92,
    }),
    suggestedValue: "a@example.com",
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "fill");
  if (action.kind === "fill") assert.equal(action.value, "No");
});

test("instructional disclaimer text is skipped instead of asked", () => {
  const action = decideFieldAction({
    field: field({
      inputType: "text",
      labelText:
        "We request the following information to help us make the best possible placement. You should complete all portions of this application that pertain to you. All information given will be held in strict confidence. Fields with Asterisks* are REQUIRED.",
      normalizedQuestion: "request following information",
      fieldCategory: "unknown",
      riskLevel: "HIGH",
      required: true,
      options: [],
    }),
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "skip");
});

test("Either on a work-type question fills Full-time when that is an option", () => {
  const action = decideFieldAction({
    field: field({
      inputType: "radio",
      labelText: "What type of work are you looking for?",
      normalizedQuestion: "type work looking",
      fieldCategory: "custom_short_answer",
      riskLevel: "MEDIUM",
      options: ["Full-time", "Part-time", "Contract"],
      required: true,
    }),
    suggestedValue: "Either",
    match: {
      fieldId: "f1",
      savedAnswerId: "a1",
      matchType: "exact",
      confidence: 0.99,
      reason: "x",
      requiresReview: false,
    },
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "fill");
  if (action.kind === "fill") assert.equal(action.value, "Full-time");
});

test("ApplicantPool acknowledgments, SMS opt-out, and today's date fill without asking", () => {
  const ack = decideFieldAction({
    field: field({
      inputType: "radio",
      labelText: "By applying to this position, I agree to ApplicantPool's Privacy Policy & Terms of Service *",
      fieldCategory: "unknown",
      riskLevel: "HIGH",
      options: ["I understand"],
      required: true,
    }),
    trustLlmAnswers: false,
  });
  assert.equal(ack.kind, "fill");
  if (ack.kind === "fill") assert.equal(ack.value, "I understand");

  const sms = decideFieldAction({
    field: field({
      inputType: "radio",
      labelText:
        "Please indicate if you agree to ApplicantPool's Applicant Communication Policy for receiving text messages. *",
      fieldCategory: "unknown",
      riskLevel: "HIGH",
      options: [
        "Yes, I agree to be contacted by text messages",
        "No, I do not agree to receive text messages",
      ],
      required: true,
    }),
    trustLlmAnswers: false,
  });
  assert.equal(sms.kind, "fill");
  if (sms.kind === "fill") assert.match(sms.value, /do not agree/i);

  const date = decideFieldAction({
    field: field({
      inputType: "text",
      labelText: "Today's Date *",
      fieldCategory: "custom_short_answer",
      riskLevel: "MEDIUM",
      options: [],
      required: true,
    }),
    trustLlmAnswers: false,
  });
  assert.equal(date.kind, "fill");
  if (date.kind === "fill") assert.match(date.value, /^\d{2}\/\d{2}\/\d{4}$/);
});
