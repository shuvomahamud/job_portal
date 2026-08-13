import assert from "node:assert/strict";
import test from "node:test";
import { parseResumeFacts, normalizeYearsValue } from "../src/resume/extractFacts";
import {
  assembleAnswerBank,
  factsToSavedAnswers,
  type CandidateFactRow,
} from "../src/formfill/answerBank";
import { matchSavedAnswer } from "../src/formfill/answerMatcher";
import { decideFieldAction } from "../src/apply/applyPolicy";
import { normalizeQuestion } from "../src/formfill/questionNormalizer";
import type { DetectedField, SavedAnswer } from "../src/formfill/types";

const factRow = (overrides: Partial<CandidateFactRow> = {}): CandidateFactRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  factKey: "years_csharp",
  factValue: "7",
  confidence: 95,
  verified: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const field = (overrides: Partial<DetectedField> = {}): DetectedField => ({
  id: "field-1",
  selector: "#years",
  tagName: "input",
  inputType: "text",
  labelText: "Years of C# experience",
  normalizedQuestion: normalizeQuestion("Years of C# experience"),
  placeholder: "",
  ariaLabel: "",
  name: "",
  idAttribute: "",
  required: true,
  options: [],
  currentValue: "",
  nearbyText: "",
  fieldCategory: "years_csharp",
  riskLevel: "LOW",
  confidence: 0.95,
  ...overrides,
});

test("normalizeYearsValue reduces messy year strings to a plain integer", () => {
  assert.equal(normalizeYearsValue("7+ years"), "7");
  assert.equal(normalizeYearsValue("about 8.5"), "8");
  assert.equal(normalizeYearsValue("10"), "10");
  assert.equal(normalizeYearsValue("several"), null);
  assert.equal(normalizeYearsValue("99"), null, "beyond a plausible career length");
});

test("parseResumeFacts normalizes years and drops unusable values", () => {
  const facts = parseResumeFacts({
    facts: [
      { key: "years_csharp", value: "7+ years", confidence: 0.95, evidence: "C# since 2018" },
      { key: "years_sql", value: "many", confidence: 0.9, evidence: "SQL work" },
      { key: "current_title", value: "  Senior   Engineer ", confidence: 0.8, evidence: "" },
    ],
  });

  assert.deepEqual(
    facts.map((fact) => [fact.key, fact.value]),
    [
      ["years_csharp", "7"],
      ["current_title", "Senior Engineer"],
    ],
    "non-numeric years are dropped rather than guessed",
  );
  assert.equal(facts[0]!.confidence, 95, "confidence is stored as 0-100");
});

test("parseResumeFacts keeps the most confident answer when a key repeats", () => {
  const facts = parseResumeFacts({
    facts: [
      { key: "years_csharp", value: "4", confidence: 0.5, evidence: "" },
      { key: "years_csharp", value: "7", confidence: 0.95, evidence: "" },
    ],
  });
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.value, "7");
});

test("parseResumeFacts rejects a key outside the allowed fact set", () => {
  assert.throws(() =>
    parseResumeFacts({
      facts: [{ key: "expected_salary", value: "200000", confidence: 0.99, evidence: "" }],
    }),
  );
});

test("a confident fact auto-fills its field instead of raising a question", () => {
  const answers = factsToSavedAnswers([factRow()]);
  assert.equal(answers.length, 1);

  const target = field();
  const match = matchSavedAnswer(target, answers);
  const action = decideFieldAction({
    field: target,
    match,
    savedAnswer: answers.find((answer) => answer.id === match?.savedAnswerId),
    suggestedValue: answers[0]!.answerValue,
    trustLlmAnswers: false,
  });

  assert.equal(action.kind, "fill");
  assert.equal(action.kind === "fill" && action.value, "7");
});

test("a low-confidence unverified fact is withheld, so the field still asks", () => {
  const answers = factsToSavedAnswers([factRow({ confidence: 40 })]);
  assert.deepEqual(answers, []);

  const target = field();
  const action = decideFieldAction({
    field: target,
    match: matchSavedAnswer(target, answers),
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "ask");
});

test("a user-verified fact is used regardless of extraction confidence", () => {
  const answers = factsToSavedAnswers([factRow({ confidence: 10, verified: true })]);
  assert.equal(answers.length, 1);
  assert.match(answers[0]!.notes, /Confirmed/);
});

test("a learned answer outranks a resume fact for the same field", () => {
  const learned: SavedAnswer = {
    id: "app-answer",
    normalizedQuestion: normalizeQuestion("Years of C# experience"),
    originalQuestion: "Years of C# experience",
    category: "years_csharp",
    answerValue: "9",
    answerType: "text",
    sitePattern: "",
    domain: "",
    usageCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    riskLevel: "LOW",
    notes: "",
    aliases: [],
  };

  const bank = assembleAnswerBank({
    jobAnswers: [],
    companyAnswers: [],
    profileAnswers: [],
    globalAnswers: [learned],
    factAnswers: factsToSavedAnswers([factRow()]),
    commonAnswers: [],
  });

  const match = matchSavedAnswer(field(), bank);
  assert.equal(match?.savedAnswerId, "app-answer", "resume must not override a saved answer");
});

test("a sensitive category stored as a fact is refused, not auto-filled", () => {
  // Nothing writes expected_salary today, but a hand-edited row must not become an
  // "exact saved answer" — that branch of applyPolicy exists for answers a human gave.
  const answers = factsToSavedAnswers([
    factRow({ factKey: "expected_salary", factValue: "200000", confidence: 99, verified: true }),
  ]);
  assert.equal(answers.length, 0, "only allowlisted fact keys may reach the answer bank");

  const salaryField = field({
    labelText: "Expected salary",
    normalizedQuestion: normalizeQuestion("Expected salary"),
    fieldCategory: "expected_salary",
    riskLevel: "MEDIUM",
  });
  const match = matchSavedAnswer(salaryField, answers);
  assert.equal(match, undefined);
  const action = decideFieldAction({
    field: salaryField,
    match,
    savedAnswer: undefined,
    trustLlmAnswers: false,
  });
  assert.equal(action.kind, "ask");
});
