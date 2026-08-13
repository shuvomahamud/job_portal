import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationToSavedAnswers,
  contractRoleFromJob,
} from "../src/formfill/authorizationPolicy";

const policy =
  "[authorized-contract-alternative] H-1B sponsorship is required for direct employment but not for contractor roles.";

test("contract roles receive sponsorship No and work authorization Yes", () => {
  const result = authorizationToSavedAnswers({
    sponsorshipAnswer: policy,
    matchingInstructions: policy,
    employmentType: "contract",
  });
  assert.equal(result.decision?.isContractRole, true);
  assert.equal(result.decision?.workAuthorization, "Yes");
  assert.equal(result.decision?.sponsorshipRequired, "No");
  assert.equal(
    result.answers.find((item) => item.category === "sponsorship_required")?.answerValue,
    "No",
  );
});

test("direct employment receives sponsorship Yes", () => {
  const result = authorizationToSavedAnswers({
    sponsorshipAnswer: policy,
    matchingInstructions: policy,
    employmentType: "full-time",
  });
  assert.equal(result.decision?.isContractRole, false);
  assert.equal(result.decision?.sponsorshipRequired, "Yes");
});

test("contract detection uses title, employment type, or visa signal", () => {
  assert.equal(contractRoleFromJob({ jobTitle: "Senior .NET Contractor" }), true);
  assert.equal(contractRoleFromJob({ employmentType: "W2 contract" }), true);
  assert.equal(contractRoleFromJob({ visaSignal: "contract_vendor_likely" }), true);
  assert.equal(contractRoleFromJob({ employmentType: "full-time" }), false);
});

test("no marker means no conditional auto-answer", () => {
  const result = authorizationToSavedAnswers({
    sponsorshipAnswer: "I need sponsorship.",
    matchingInstructions: null,
    employmentType: "contract",
  });
  assert.deepEqual(result, { answers: [], decision: null });
});
