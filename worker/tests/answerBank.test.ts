import assert from "node:assert/strict";
import test from "node:test";
import { matchSavedAnswer } from "../src/formfill/answerMatcher";
import {
  assembleAnswerBank,
  addressToSavedAnswers,
  commonAnswerToSavedAnswer,
  profileToSavedAnswers,
} from "../src/formfill/answerBank";
import { buildSuggestion } from "../src/formfill/suggestions";
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
    factAnswers: [],
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

test("historical resume cities do not make the current profile city ambiguous", () => {
  const [profileCity] = profileToSavedAnswers({ city: "Latham" }).filter(
    (answer) => answer.category === "city",
  );
  assert.ok(profileCity);
  const historicalCities = [
    saved({
      id: "fiftytwo-city",
      normalizedQuestion: "location senior software engineer fiftytwo digital",
      originalQuestion: "Location for Senior Software Engineer FiftyTwo Digital",
      category: "city",
      answerValue: "Copenhagen, Denmark",
      riskLevel: "LOW",
    }),
    saved({
      id: "mercy-city",
      normalizedQuestion: "location mercy university",
      originalQuestion: "Location for Mercy University",
      category: "city",
      answerValue: "Dobbs Ferry, New York",
      riskLevel: "LOW",
    }),
  ];
  const field: DetectedField = {
    ...phoneField(),
    id: "current-city",
    selector: "#current-city",
    inputType: "text",
    labelText: "What is your current city of residence?",
    normalizedQuestion: "current city residence",
    name: "current-city",
    idAttribute: "current-city",
    fieldCategory: "city",
    confidence: 0.98,
  };

  const suggestion = buildSuggestion(field, [profileCity, ...historicalCities]);
  assert.equal(suggestion.savedAnswer?.id, "profile:city");
  assert.equal(suggestion.suggestedValue, "Latham");
  assert.equal(suggestion.match?.matchType, "rule");
});

test("current city of residence uses the address nearer the posting, not a learned city", () => {
  const currentCity: DetectedField = {
    ...phoneField(),
    id: "current-city",
    selector: "#current-city",
    inputType: "text",
    labelText: "What is your current city of residence?",
    normalizedQuestion: "current city residence",
    name: "current-city",
    idAttribute: "current-city",
    fieldCategory: "city",
    confidence: 0.98,
  };
  const learnedLatham = saved({
    id: "learned-current-city",
    normalizedQuestion: "current city residence",
    originalQuestion: "What is your current city of residence?",
    category: "city",
    answerValue: "Latham",
    riskLevel: "LOW",
  });
  const nyc = addressToSavedAnswers(
    [
      {
        id: "latham",
        label: "Latham",
        line1: "44 Omega Ter",
        line2: null,
        city: "Latham",
        stateRegion: "NY",
        postalCode: "12110",
        country: "United States",
        isPrimary: true,
        matchTerms: ["latham", "albany"],
      },
      {
        id: "queens",
        label: "South Richmond Hill",
        line1: "10535 130th St",
        line2: null,
        city: "South Richmond Hill",
        stateRegion: "NY",
        postalCode: "11419",
        country: "United States",
        isPrimary: false,
        matchTerms: ["south richmond hill", "queens", "new york", "nyc"],
      },
    ],
    { location: "New York, NY, US" },
  );
  const nycCity = nyc.answers.find((answer) => answer.category === "city");
  const nycZip = nyc.answers.find((answer) => answer.category === "zip");
  assert.equal(nyc.label, "South Richmond Hill");
  assert.equal(nycCity?.answerValue, "South Richmond Hill");
  assert.equal(nycZip?.answerValue, "11419");

  const suggestion = buildSuggestion(currentCity, [...nyc.answers, learnedLatham]);
  assert.equal(suggestion.savedAnswer?.id, "profile:city");
  assert.equal(suggestion.suggestedValue, "South Richmond Hill");
});
