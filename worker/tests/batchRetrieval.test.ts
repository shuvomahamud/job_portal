import assert from "node:assert/strict";
import test from "node:test";
import { retrieveAnswersWithOllamaBatch } from "../src/formfill/suggestions";
import type { DetectedField, MatchSettings, SavedAnswer } from "../src/formfill/types";

const settings: MatchSettings = {
  ollamaBaseUrl: "http://127.0.0.1:11434",
  selectedModel: "qwen3.5:9b",
  autoFillConfidenceThreshold: 0.88,
  allowAutoFillLowRisk: false,
  requireReviewMediumHigh: true,
  useOllamaForAmbiguous: true,
  allowOneClickSavedGender: true,
  allowOneClickSavedWorkEligibility: true,
};

function field(over: Partial<DetectedField> = {}): DetectedField {
  return {
    id: "f1",
    selector: "#f1",
    tagName: "input",
    inputType: "text",
    labelText: "Do you require sponsorship?",
    normalizedQuestion: "require sponsorship",
    placeholder: "",
    ariaLabel: "",
    name: "",
    idAttribute: "",
    required: true,
    options: [],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "sponsorship_required",
    riskLevel: "MEDIUM",
    confidence: 0.4,
    ...over,
  };
}

function answer(over: Partial<SavedAnswer> = {}): SavedAnswer {
  return {
    id: "common:sponsorship",
    normalizedQuestion: "sponsorship required",
    originalQuestion: "Will you now or in the future require sponsorship?",
    category: "sponsorship_required",
    answerValue: "No",
    answerType: "text",
    sitePattern: "",
    domain: "",
    usageCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    riskLevel: "MEDIUM",
    notes: "",
    aliases: [],
    ...over,
  };
}

/** Captures the request the batch function actually sent, so its shape can be asserted. */
function mockOllama(reply: unknown) {
  let capturedBody: unknown = null;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({ message: { content: JSON.stringify(reply) } }),
    );
  }) as unknown as typeof fetch;
  return {
    restore: () => { globalThis.fetch = original; },
    request: () => capturedBody as { messages: Array<{ role: string; content: string }> },
  };
}

test("one page with three unresolved questions makes exactly one call", async () => {
  const mock = mockOllama({
    matches: [
      { fieldId: "f1", matchedAnswerId: "common:sponsorship", confidence: 0.95, reason: "same question", requiresReview: false },
      { fieldId: "f2", matchedAnswerId: null, confidence: 0, reason: "nothing matches", requiresReview: false },
      { fieldId: "f3", matchedAnswerId: "common:sponsorship", confidence: 0.3, reason: "weak", requiresReview: true },
    ],
  });
  try {
    let calls = 0;
    const countingFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return countingFetch(...args);
    }) as typeof fetch;

    const fields = [
      field({ id: "f1", labelText: "Do you require sponsorship?" }),
      field({ id: "f2", labelText: "What is your favorite color?" }),
      field({ id: "f3", labelText: "Sponsorship needed?" }),
    ];
    const results = await retrieveAnswersWithOllamaBatch(fields, [answer()], settings);

    // The whole point: three unresolved questions, one HTTP call, not three.
    assert.equal(calls, 1);

    const userMessage = JSON.parse(mock.request().messages[1]!.content);
    assert.equal(userMessage.questions.length, 3, "all three questions went in one request");

    assert.equal(results.size, 1, "only the confident, non-review match is returned");
    assert.equal(results.get("f1")?.suggestedValue, "No");
    assert.equal(results.has("f2"), false, "no matchedAnswerId means no result");
    assert.equal(results.has("f3"), false, "requiresReview means no result, despite a matchedAnswerId");
  } finally {
    mock.restore();
  }
});

test("the model may only pick from the ids it was actually given", async () => {
  // The whole safety contract: never invent an answer. Confirmed by feeding back an id
  // that was never in the candidate list and checking it is refused, not trusted.
  const mock = mockOllama({
    matches: [
      { fieldId: "f1", matchedAnswerId: "made-up-id-not-in-bank", confidence: 0.99, reason: "hallucinated", requiresReview: false },
    ],
  });
  try {
    const results = await retrieveAnswersWithOllamaBatch(
      [field({ id: "f1" })],
      [answer()],
      settings,
    );
    assert.equal(results.size, 0);
  } finally {
    mock.restore();
  }
});

test("Ollama being unreachable resolves nothing rather than throwing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  try {
    const results = await retrieveAnswersWithOllamaBatch(
      [field()],
      [answer()],
      settings,
    );
    assert.equal(results.size, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("no candidate answers means no call at all", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  try {
    const results = await retrieveAnswersWithOllamaBatch([field()], [], settings);
    assert.equal(called, false);
    assert.equal(results.size, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("disabled Ollama use never reaches the network", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  try {
    const results = await retrieveAnswersWithOllamaBatch(
      [field()],
      [answer()],
      { ...settings, useOllamaForAmbiguous: false },
    );
    assert.equal(called, false);
    assert.equal(results.size, 0);
  } finally {
    globalThis.fetch = original;
  }
});
