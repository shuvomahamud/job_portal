import assert from "node:assert/strict";
import test from "node:test";
import { matchSavedAnswer } from "../src/formfill/answerMatcher";
import {
  assembleAnswerBank,
  commonAnswerToSavedAnswer,
  profileToSavedAnswers,
} from "../src/formfill/answerBank";
import type { DetectedField, SavedAnswer } from "../src/formfill/types";

function phoneField(): DetectedField {
  return {
    id: "phone",
    selector: "#phone",
    tagName: "input",
    inputType: "tel",
    labelText: "Phone number",
    normalizedQuestion: "phone",
    placeholder: "",
    ariaLabel: "",
    name: "phone",
    idAttribute: "phone",
    required: true,
    options: [],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "phone",
    riskLevel: "LOW",
    confidence: 0.99,
  };
}

function salaryField(): DetectedField {
  return {
    id: "salary",
    selector: "#salary",
    tagName: "input",
    inputType: "text",
    labelText: "Expected annual salary",
    normalizedQuestion: "expected salary",
    placeholder: "",
    ariaLabel: "",
    name: "expected_salary",
    idAttribute: "salary",
    required: true,
    options: [],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "expected_salary",
    riskLevel: "MEDIUM",
    confidence: 0.92,
  };
}

function saved(overrides: Partial<SavedAnswer>): SavedAnswer {
  return {
    id: "x",
    normalizedQuestion: "expected salary",
    originalQuestion: "Expected salary",
    category: "expected_salary",
    answerValue: "100000",
    answerType: "text",
    sitePattern: "",
    domain: "",
    usageCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    riskLevel: "MEDIUM",
    notes: "",
    aliases: [],
    ...overrides,
  };
}

test("application_answers shadow common_answers but not candidate_profile.phone", () => {
  const profileAnswers = profileToSavedAnswers({
    phone: "555-0100",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
  });
  const phoneFromProfile = profileAnswers.find((answer) => answer.category === "phone");
  assert.ok(phoneFromProfile);
  assert.equal(phoneFromProfile.answerValue, "555-0100");

  const learnedPhone = saved({
    id: "app-phone",
    normalizedQuestion: "phone",
    originalQuestion: "Phone",
    category: "phone",
    answerValue: "555-9999",
    riskLevel: "LOW",
  });
  const commonSalary = commonAnswerToSavedAnswer({
    id: "common-1",
    questionKey: "expected_salary",
    questionText: "Expected annual salary",
    answerText: "120000",
    category: "expected_salary",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const learnedSalary = saved({
    id: "app-salary",
    answerValue: "150000",
  });

  const bank = assembleAnswerBank({
    jobAnswers: [],
    companyAnswers: [],
    profileAnswers,
    globalAnswers: [learnedPhone, learnedSalary],
    commonAnswers: [commonSalary],
  });

  const phoneMatch = matchSavedAnswer(phoneField(), bank);
  assert.equal(phoneMatch?.savedAnswerId, phoneFromProfile.id);
  assert.equal(
    bank.find((answer) => answer.id === phoneMatch?.savedAnswerId)?.answerValue,
    "555-0100",
  );

  const salaryMatch = matchSavedAnswer(salaryField(), bank);
  assert.equal(salaryMatch?.savedAnswerId, "app-salary");
  assert.equal(
    bank.find((answer) => answer.id === salaryMatch?.savedAnswerId)?.answerValue,
    "150000",
  );
});
