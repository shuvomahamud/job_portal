import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  isHistoricalResumeLocationField,
  listIncompleteResumeCards,
  pendingAsksFromResumeCards,
  withResumeCardContext,
} from "../src/apply/resumeCards";
import { loadPlaywright } from "../src/browser/session";
import type { DetectedField, SavedAnswer } from "../src/formfill/types";

function field(over: Partial<DetectedField> = {}): DetectedField {
  return {
    id: "f1",
    selector: "#location",
    tagName: "input",
    inputType: "text",
    labelText: "Location",
    normalizedQuestion: "location",
    placeholder: "",
    ariaLabel: "",
    name: "location",
    idAttribute: "location",
    required: true,
    options: [],
    currentValue: "",
    nearbyText: "",
    fieldCategory: "city",
    riskLevel: "LOW",
    confidence: 0.93,
    ...over,
  };
}

test("a current-city field is not treated as a historical resume location", () => {
  assert.equal(
    isHistoricalResumeLocationField(
      field({ labelText: "City", nearbyText: "Contact information" }),
    ),
    false,
  );
});

test("an opened resume-card location is historical and must not use the profile city", () => {
  const card = {
    selector: "button:nth-of-type(2)",
    heading: "Senior Software Engineer FiftyTwo Digital",
    section: "work" as const,
  };
  const opened = withResumeCardContext(field(), card);
  assert.equal(isHistoricalResumeLocationField(opened), true);
  assert.match(opened.labelText, /FiftyTwo Digital/);
});

test("incomplete resume cards become distinct pending questions", () => {
  const asks = pendingAsksFromResumeCards([
    {
      selector: "#edit-1",
      heading: "Senior Software Engineer at FiftyTwo Digital",
      section: "work",
    },
    {
      selector: "#edit-2",
      heading: "Master of Science in Data Science Mercy University",
      section: "education",
    },
  ]);
  assert.equal(asks.length, 2);
  assert.match(asks[0]!.field.labelText, /FiftyTwo Digital/);
  assert.match(asks[1]!.field.labelText, /Mercy University/);
  assert.notEqual(asks[0]!.field.normalizedQuestion, asks[1]!.field.normalizedQuestion);
  assert.equal(asks[0]!.field.required, true);
  assert.equal(asks[1]!.field.required, true);
});

test("a saved resume-card location is not asked again as a synthetic question", () => {
  const card = {
    selector: "#edit-1",
    heading: "Senior Software Engineer FiftyTwo Digital",
    section: "work" as const,
  };
  const saved: SavedAnswer = {
    id: "fiftytwo-city",
    normalizedQuestion: "location senior software engineer fiftytwo digital",
    originalQuestion: "Location for Senior Software Engineer FiftyTwo Digital",
    category: "city",
    answerValue: "Copenhagen, Denmark",
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
  const asks = pendingAsksFromResumeCards([card], [saved]);
  assert.equal(asks.length, 0);
});

test("Indeed resume-detail warnings select the incomplete edit cards", async () => {
  const playwright = await loadPlaywright();
  const userDataDir = await mkdtemp(join(tmpdir(), "resume-cards-"));
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
  });
  try {
    const page = await context.newPage();
    const url = pathToFileURL(
      join(process.cwd(), "worker/tests/fixtures/indeed-resume-details.html"),
    ).href;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const cards = await listIncompleteResumeCards(page);
    const headings = cards.map((card) => card.heading).join(" | ");
    assert.ok(cards.length >= 3, `expected incomplete cards, got: ${headings}`);
    assert.ok(headings.includes("FiftyTwo Digital"));
    assert.ok(headings.includes("Mercy University"));
    assert.ok(headings.includes("Khulna University"));
    assert.ok(!headings.includes("SSD Tech"), "complete New York card must stay closed");
  } finally {
    await context.close();
  }
});
