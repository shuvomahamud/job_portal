import assert from "node:assert/strict";
import test from "node:test";
import {
  containsTerm,
  normalizeLocationText,
  pickAddressForJob,
  previewAddressChoices,
  suggestedTermsForCity,
} from "../../src/lib/addressPolicy";
import { addressToSavedAnswers, type CandidateAddressRow } from "../src/formfill/answerBank";

const nyc: CandidateAddressRow = {
  id: "nyc",
  label: "New York City",
  line1: "12 Broad St",
  line2: "Apt 4",
  city: "New York",
  stateRegion: "NY",
  postalCode: "10004",
  country: "United States",
  isPrimary: true,
  matchTerms: suggestedTermsForCity("new york"),
};

const albany: CandidateAddressRow = {
  id: "albany",
  label: "Albany",
  line1: "8 Pine Ave",
  line2: null,
  city: "Albany",
  stateRegion: "NY",
  postalCode: "12207",
  country: "United States",
  isPrimary: false,
  matchTerms: suggestedTermsForCity("albany"),
};

const both = [nyc, albany];
const pick = (location: string | null, remoteType?: string | null) =>
  pickAddressForJob(both, { location, remoteType })!;

test("normalization strips punctuation without merging words", () => {
  assert.equal(normalizeLocationText("New York, NY, US"), "new york ny us");
  assert.equal(normalizeLocationText("Albany,NY"), "albany ny");
});

test("term matching respects word boundaries", () => {
  assert.equal(containsTerm("albany ny", "ny"), true);
  assert.equal(containsTerm("albany ny", "alb"), false, "no partial-word matches");
  assert.equal(containsTerm("sunnyvale ca", "ny"), false, "must not match inside a word");
});

// The strings below are the real distinct location values from the jobs table.
test("real posting locations route to the right address", () => {
  assert.equal(pick("New York, NY, US").address.id, "nyc");
  assert.equal(pick("New York").address.id, "nyc");
  assert.equal(pick("Long Island City, NY, US").address.id, "nyc");
  assert.equal(pick("Albany, NY").address.id, "albany");
  assert.equal(pick("Schenectady, NY, US").address.id, "albany", "metro term resolves");
  assert.equal(pick("Brooklyn, NY").address.id, "nyc");
});

test("a bare state matches both equally and defers to the primary address", () => {
  const choice = pick("NY");
  assert.equal(choice.address.id, "nyc", "nyc is flagged primary");
  assert.match(choice.reason, /matched more than one address equally/);
});

test("remote and unspecified postings use the primary address", () => {
  for (const location of ["Remote (United States)", "Remote, US", "USA", null]) {
    const choice = pick(location, location === null ? null : "remote");
    assert.equal(choice.address.id, "nyc", `expected primary for ${location}`);
  }
  assert.match(pick(null).reason, /no specific location/);
});

test("an out-of-state posting falls back rather than guessing", () => {
  const choice = pick("Arlington, VA, US");
  assert.equal(choice.address.id, "nyc");
  assert.match(choice.reason, /matched no address/);
});

test("primary flag decides the fallback, not list order", () => {
  const albanyPrimary = [
    { ...nyc, isPrimary: false },
    { ...albany, isPrimary: true },
  ];
  const choice = pickAddressForJob(albanyPrimary, { location: "Remote, US" })!;
  assert.equal(choice.address.id, "albany");
  // A specific NYC posting must still win on its own merit.
  assert.equal(
    pickAddressForJob(albanyPrimary, { location: "New York, NY, US" })!.address.id,
    "nyc",
  );
});

test("a single address on file is always used", () => {
  const choice = pickAddressForJob([albany], { location: "New York, NY, US" })!;
  assert.equal(choice.address.id, "albany");
});

test("no addresses on file returns null so the profile address still applies", () => {
  assert.equal(pickAddressForJob([], { location: "New York, NY" }), null);
});

test("the chosen address becomes the address answers, line2 folded in", () => {
  const result = addressToSavedAnswers(both, { location: "Albany, NY" });
  assert.equal(result.label, "Albany");
  const byCategory = Object.fromEntries(
    result.answers.map((answer) => [answer.category, answer.answerValue]),
  );
  assert.equal(byCategory.address, "8 Pine Ave");
  assert.equal(byCategory.city, "Albany");
  assert.equal(byCategory.state, "NY");
  assert.equal(byCategory.zip, "12207");

  const nycResult = addressToSavedAnswers(both, { location: "New York, NY, US" });
  assert.equal(
    Object.fromEntries(nycResult.answers.map((a) => [a.category, a.answerValue])).address,
    "12 Broad St, Apt 4",
    "line2 is appended when present",
  );
});

test("the dashboard preview reports the same choice the apply run makes", () => {
  const locations = [
    { location: "New York, NY, US", remoteType: null },
    { location: "Albany, NY", remoteType: null },
    { location: "Remote, US", remoteType: "remote" },
  ];
  const rows = previewAddressChoices(both, locations);

  assert.deepEqual(
    rows.map((row) => [row.location, row.label]),
    [
      ["New York, NY, US", "New York City"],
      ["Albany, NY", "Albany"],
      ["Remote, US", "New York City"],
    ],
  );
  // Whatever the preview claims must be what pickAddressForJob actually returns.
  for (const [index, job] of locations.entries()) {
    assert.equal(rows[index]!.label, pickAddressForJob(both, job)!.address.label);
  }
  assert.equal(rows[2]!.usedFallback, true, "remote is a fallback, and is labelled so");
  assert.equal(rows[0]!.usedFallback, false);
});

test("the preview collapses duplicate locations and keeps order", () => {
  const rows = previewAddressChoices(both, [
    { location: "New York, NY, US" },
    { location: "new york,  ny,  us" },
    { location: "Albany, NY" },
  ]);
  assert.equal(rows.length, 2, "the same place written differently is one row");
  assert.deepEqual(rows.map((row) => row.label), ["New York City", "Albany"]);
});

test("the preview explains itself when no addresses are on file", () => {
  const rows = previewAddressChoices([], [{ location: "New York, NY" }]);
  assert.equal(rows[0]!.label, null);
  assert.match(rows[0]!.reason, /profile address/);
});

test("a missing location is shown rather than dropped", () => {
  const rows = previewAddressChoices(both, [{ location: null }]);
  assert.equal(rows[0]!.location, "(no location given)");
  assert.equal(rows[0]!.label, "New York City");
});

test("address answers carry the profile id prefix so applyPolicy treats them as identity", () => {
  const result = addressToSavedAnswers(both, { location: "Albany, NY" });
  for (const answer of result.answers) {
    assert.ok(answer.id.startsWith("profile:"), `${answer.id} must be a profile entry`);
  }
});
