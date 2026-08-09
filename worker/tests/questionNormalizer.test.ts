import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeQuestion,
  questionSimilarity,
} from "../src/formfill/questionNormalizer";

test("normalizeQuestion canonicalizes sponsorship synonyms", () => {
  const questions = [
    "Do you now or in the future require sponsorship?",
    "Will you require visa sponsorship now or in the future?",
    "Do you need H-1B sponsorship?",
  ];
  assert.deepEqual(questions.map(normalizeQuestion), [
    "sponsorship required",
    "sponsorship required",
    "sponsorship required",
  ]);
});

test("normalizeQuestion canonicalizes C# and .NET experience questions", () => {
  assert.equal(normalizeQuestion("How many years of C# experience?"), "years csharp");
  assert.equal(normalizeQuestion("Years working with .NET"), "years dotnet");
});

test("normalizeQuestion removes punctuation, filler, whitespace, and repeated words", () => {
  assert.equal(normalizeQuestion("  What is your preferred preferred ROLE?! "), "preferred role");
});

test("questionSimilarity scores related questions above unrelated questions", () => {
  assert.ok(
    questionSimilarity("Why do you want to join this team?", "Why join our team?") >
      questionSimilarity("Why do you want to join this team?", "Street address"),
  );
});
