import assert from "node:assert/strict";
import test from "node:test";
import {
  locationAnswersFromResumeEntries,
  matchResumeEntry,
  parseLocationParts,
  parseResumeEntries,
  splitOrganizationLocation,
} from "../src/resume/parseEntries";
import { resolveResumeCardLocation } from "../src/apply/resumeCards";
import { buildSuggestion } from "../src/formfill/suggestions";
import type { DetectedField, SavedAnswer } from "../src/formfill/types";

const RESUME = `
PROFESSIONAL EXPERIENCE

Senior Software Engineer 11/2025 - Present
SSD Tech / NYPA, New York
Designed and built a document digitization platform.

Senior Software Engineer 08/2024 - 10/2025
PCNET Solutions LLC, Los Angeles, CA
Delivered recruiting platforms.

Information Technology Specialist - Programming. 08/2023 - 07/2024
Office of Information Technology Services, New York
Led the restructuring of the Employee Training Tracker.

Senior Software Engineer. 12/2018 - 07/2023
FiftyTwo Digital, Denmark
Ensured data integrity and compliance in API Mode.

Software Engineer. 05/2015 - 11/2018
Systems Solutions & Development Technologies, Bangladesh
Developed and enhanced the Doze CRM system.

EDUCATION

Master of Science, Data Science 01/2022 - 05/2023
Mercy University

Bachelor of Science, Computer Science. 03/2010 - 12/2014
Khulna University of Engineering and Technology
`;

function field(over: Partial<DetectedField> = {}): DetectedField {
  return {
    id: "f1",
    selector: "#location",
    tagName: "input",
    inputType: "text",
    labelText: "Location for Senior Software Engineer FiftyTwo Digital",
    normalizedQuestion: "location senior software engineer fiftytwo digital",
    placeholder: "",
    ariaLabel: "",
    name: "location",
    idAttribute: "location",
    required: true,
    options: [],
    currentValue: "",
    nearbyText: "work FiftyTwo Digital",
    fieldCategory: "city",
    riskLevel: "LOW",
    confidence: 0.93,
    ...over,
  };
}

function saved(over: Partial<SavedAnswer> = {}): SavedAnswer {
  return {
    id: "current-city",
    normalizedQuestion: "current city residence",
    originalQuestion: "What is your current city of residence?",
    category: "city",
    answerValue: "Latham",
    answerType: "text",
    sitePattern: "",
    domain: "",
    usageCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    riskLevel: "LOW",
    notes: "",
    aliases: [],
    ...over,
  };
}

test("splitOrganizationLocation peels city/state/country off the employer line", () => {
  assert.deepEqual(splitOrganizationLocation("FiftyTwo Digital, Denmark"), {
    organization: "FiftyTwo Digital",
    location: "Denmark",
  });
  assert.deepEqual(splitOrganizationLocation("PCNET Solutions LLC, Los Angeles, CA"), {
    organization: "PCNET Solutions LLC",
    location: "Los Angeles, CA",
  });
  assert.deepEqual(splitOrganizationLocation("SSD Tech / NYPA, New York"), {
    organization: "SSD Tech / NYPA",
    location: "New York",
  });
  assert.deepEqual(splitOrganizationLocation("Mercy University"), {
    organization: "Mercy University",
    location: null,
  });
});

test("parseResumeEntries reads work locations from the resume, not the mailing address", () => {
  const entries = parseResumeEntries(RESUME);
  const byOrg = Object.fromEntries(entries.map((entry) => [entry.organization, entry]));
  assert.equal(byOrg["FiftyTwo Digital"]?.title, "Senior Software Engineer");
  assert.equal(byOrg["PCNET Solutions LLC"]?.location, "Los Angeles, CA");
  assert.equal(byOrg["SSD Tech / NYPA"]?.location, "New York");
  assert.equal(byOrg["Office of Information Technology Services"]?.location, "New York");
  assert.equal(byOrg["Systems Solutions & Development Technologies"]?.location, "Bangladesh");
  assert.equal(byOrg["Mercy University"]?.location, null);
  assert.equal(byOrg["Khulna University of Engineering and Technology"]?.kind, "education");
});

test("a resume-card heading maps to that job's parsed location", () => {
  const entries = parseResumeEntries(RESUME);
  const fiftytwo = matchResumeEntry("Senior Software Engineer FiftyTwo Digital", entries);
  assert.equal(fiftytwo?.location, "Denmark");
  const resolved = resolveResumeCardLocation(
    { selector: "#edit", heading: "Senior Software Engineer FiftyTwo Digital", section: "work" },
    [],
    entries,
  );
  assert.deepEqual(resolved, { value: "Denmark", source: "resume" });
});

test("current-city answers in the question bank are ignored for experience location", () => {
  const suggestion = buildSuggestion(field(), [
    saved(),
    saved({
      id: "profile:city",
      normalizedQuestion: "city",
      originalQuestion: "City",
      answerValue: "South Richmond Hill",
    }),
  ]);
  assert.equal(suggestion.suggestedValue, "");
  assert.equal(suggestion.savedAnswer, undefined);
});

test("a Location-for answer still fills that resume card", () => {
  const suggestion = buildSuggestion(field(), [
    saved(),
    saved({
      id: "fiftytwo",
      normalizedQuestion: "location senior software engineer fiftytwo digital",
      originalQuestion: "Location for Senior Software Engineer FiftyTwo Digital",
      answerValue: "Copenhagen, Denmark",
    }),
  ]);
  assert.equal(suggestion.suggestedValue, "Copenhagen, Denmark");
});

test("locationAnswersFromResumeEntries only keep entries that named a place", () => {
  const answers = locationAnswersFromResumeEntries(parseResumeEntries(RESUME));
  assert.ok(answers.some((answer) => answer.answerValue === "Denmark"));
  assert.ok(!answers.some((answer) => /mercy university/i.test(answer.originalQuestion)));
});

test("parseLocationParts splits city vs country for form fields", () => {
  assert.deepEqual(parseLocationParts("Copenhagen, Denmark"), {
    city: "Copenhagen",
    state: null,
    country: "Denmark",
    full: "Copenhagen, Denmark",
  });
  assert.equal(parseLocationParts("Los Angeles, CA").city, "Los Angeles");
  assert.equal(parseLocationParts("Los Angeles, CA").state, "CA");
});
