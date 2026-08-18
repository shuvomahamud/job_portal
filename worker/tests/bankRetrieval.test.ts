import assert from "node:assert/strict";
import test from "node:test";
import { decideFieldAction } from "../src/apply/applyPolicy";
import { classifyField } from "../src/formfill/fieldClassifier";
import {
  educationRecordsFromAnswers,
  formatEducationRecord,
  isEducationCompositeQuestion,
  isPriorEmployerQuestion,
  isSkillsOrCertificatesQuestion,
  matchDerivedBankAnswer,
} from "../src/formfill/bankRetrieval";
import { isHistoricalResumeLocationField } from "../src/apply/resumeCards";
import { normalizeQuestion } from "../src/formfill/questionNormalizer";
import type { DetectedField, SavedAnswer } from "../src/formfill/types";

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: "f1",
    selector: "#q",
    tagName: "input",
    inputType: "text",
    labelText: "Have you previously been employed with USALCO? *",
    normalizedQuestion: normalizeQuestion("Have you previously been employed with USALCO? *"),
    placeholder: "",
    ariaLabel: "",
    name: "",
    idAttribute: "",
    required: true,
    options: ["Yes", "No"],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "custom_short_answer",
    riskLevel: "MEDIUM",
    confidence: 0.55,
    ...overrides,
  };
}

function saved(overrides: Partial<SavedAnswer> = {}): SavedAnswer {
  return {
    id: "a1",
    normalizedQuestion: "employer senior software engineer bits bytes",
    originalQuestion: "Employer for Senior Software Engineer Bits and Bytes Technology Solutions / NYPA",
    category: "custom_short_answer",
    answerValue: "Bits and Bytes Technology Solutions / NYPA",
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

const educationAnswers: SavedAnswer[] = [
  saved({
    id: "school-ms",
    originalQuestion: "School for Master of Science in Data Science Mercy University",
    normalizedQuestion: "school master science data mercy university",
    answerValue: "Mercy University",
  }),
  saved({
    id: "loc-ms",
    originalQuestion: "Location for Master of Science in Data Science Mercy University",
    normalizedQuestion: "location master science data mercy university",
    category: "city",
    answerValue: "Dobbs Ferry, New York, United States",
  }),
  saved({
    id: "deg-ms",
    originalQuestion: "Degree for Master of Science in Data Science Mercy University",
    normalizedQuestion: "degree master science data mercy university",
    answerValue: "Master of Science",
  }),
  saved({
    id: "field-ms",
    originalQuestion: "Field of study for Master of Science in Data Science Mercy University",
    normalizedQuestion: "field study master science data mercy university",
    answerValue: "Data Science",
  }),
  saved({
    id: "school-bs",
    originalQuestion: "School for Bachelor of Science in Computer Science Khulna University of Engineering and Technology",
    normalizedQuestion: "school bachelor science computer khulna university",
    answerValue: "Khulna University of Engineering and Technology",
  }),
  saved({
    id: "loc-bs",
    originalQuestion: "Location for Bachelor of Science in Computer Science Khulna University of Engineering and Technology",
    normalizedQuestion: "location bachelor science computer khulna university",
    category: "city",
    answerValue: "Khulna, Bangladesh",
  }),
  saved({
    id: "deg-bs",
    originalQuestion: "Degree for Bachelor of Science in Computer Science Khulna University of Engineering and Technology",
    normalizedQuestion: "degree bachelor science computer khulna university",
    answerValue: "Bachelor of Science",
  }),
  saved({
    id: "field-bs",
    originalQuestion: "Field of study for Bachelor of Science in Computer Science Khulna University of Engineering and Technology",
    normalizedQuestion: "field study bachelor science computer khulna university",
    answerValue: "Computer Science",
  }),
  saved({
    id: "skills",
    originalQuestion: "Technical skills",
    normalizedQuestion: "technical skills",
    category: "custom_long_answer",
    answerValue: "C#, .NET Core, Angular, SQL Server, Azure",
  }),
  saved({
    id: "edu",
    originalQuestion: "What is your educational background?",
    normalizedQuestion: "educational background",
    category: "custom_long_answer",
    answerValue: "MS Data Science, Mercy University; BS Computer Science, KUET",
  }),
];

test("Usalco-style questions are recognized as bank-retrievable", () => {
  assert.equal(isPriorEmployerQuestion("Have you previously been employed with USALCO? *"), true);
  assert.equal(isEducationCompositeQuestion("University, City & State, Degree"), true);
  assert.equal(isEducationCompositeQuestion("Graduate School, City & State, Degree"), true);
  assert.equal(isEducationCompositeQuestion("Trade School, City & State, Degree"), true);
  assert.equal(
    isSkillsOrCertificatesQuestion(
      "List any other education, special skills or certificates/licenses that you possess related to the job.",
    ),
    true,
  );
});

test("combined school fields are not classified as the current city", () => {
  assert.equal(classifyField({
    labelText: "University, City & State, Degree",
    normalizedQuestion: "university city state degree",
    placeholder: "",
    ariaLabel: "",
    name: "",
    idAttribute: "",
    nearbyText: "",
    inputType: "text",
    tagName: "input",
  }).category, "custom_short_answer");
  assert.equal(
    isHistoricalResumeLocationField(
      field({
        labelText: "University, City & State, Degree",
        fieldCategory: "city",
        normalizedQuestion: "university city state degree",
      }),
    ),
    false,
  );
});

test("prior-employer questions answer No when the company is not in work history", () => {
  const suggestion = matchDerivedBankAnswer(field(), [saved()], "Usalco");
  assert.equal(suggestion?.suggestedValue, "No");
  const action = decideFieldAction({
    field: field(),
    match: suggestion?.match,
    savedAnswer: suggestion?.savedAnswer,
    suggestedValue: suggestion?.suggestedValue,
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "fill");
  if (action.kind === "fill") assert.equal(action.value, "No");
});

test("prior-employer questions answer Yes when the company is a saved employer", () => {
  const suggestion = matchDerivedBankAnswer(
    field({ labelText: "Have you previously been employed with NYPA?" }),
    [saved()],
    "NYPA",
  );
  assert.equal(suggestion?.suggestedValue, "Yes");
});

test("education composite fields reuse school, location, and degree from the bank", () => {
  const records = educationRecordsFromAnswers(educationAnswers);
  assert.equal(records.length, 2);
  const graduate = matchDerivedBankAnswer(
    field({
      labelText: "Graduate School, City & State, Degree",
      required: false,
      options: [],
      fieldCategory: "custom_short_answer",
    }),
    educationAnswers,
    "Usalco",
  );
  assert.match(graduate?.suggestedValue ?? "", /Mercy University/);
  assert.match(graduate?.suggestedValue ?? "", /Master of Science in Data Science/);
  assert.equal(formatEducationRecord(records.find((row) => row.kind === "graduate")!), graduate?.suggestedValue);

  const trade = matchDerivedBankAnswer(
    field({
      labelText: "Trade School, City & State, Degree",
      required: false,
      options: [],
      fieldCategory: "custom_short_answer",
    }),
    educationAnswers,
    "Usalco",
  );
  assert.equal(trade?.suggestedValue, "None");
});

test("skills and certificate questions reuse education and technical-skills answers", () => {
  const suggestion = matchDerivedBankAnswer(
    field({
      labelText:
        "List any other education, special skills or certificates/licenses that you possess related to the job.",
      inputType: "textarea",
      tagName: "textarea",
      required: false,
      options: [],
      fieldCategory: "custom_long_answer",
      riskLevel: "HIGH",
      confidence: 0.64,
    }),
    educationAnswers,
    "Usalco",
  );
  assert.match(suggestion?.suggestedValue ?? "", /MS Data Science/);
  assert.match(suggestion?.suggestedValue ?? "", /C#, \.NET Core/);
  const action = decideFieldAction({
    field: field({
      fieldCategory: "custom_long_answer",
      riskLevel: "HIGH",
      confidence: 0.64,
      required: false,
      inputType: "textarea",
      options: [],
    }),
    match: suggestion?.match,
    savedAnswer: suggestion?.savedAnswer,
    suggestedValue: suggestion?.suggestedValue,
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "fill");
});
