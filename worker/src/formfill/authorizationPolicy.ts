import type { FieldCategory, SavedAnswer } from "./types";

export const CONTRACT_NO_SPONSORSHIP_MARKER = "[authorized-contract-alternative]";

export type AuthorizationDecision = {
  isContractRole: boolean;
  workAuthorization: "Yes";
  sponsorshipRequired: "Yes" | "No";
  reason: string;
};

export function usesContractNoSponsorshipPolicy(
  sponsorshipAnswer: string | null | undefined,
  matchingInstructions: string | null | undefined,
): boolean {
  return `${sponsorshipAnswer ?? ""} ${matchingInstructions ?? ""}`
    .toLowerCase()
    .includes(CONTRACT_NO_SPONSORSHIP_MARKER);
}

export function contractRoleFromJob(input: {
  jobTitle?: string | null;
  employmentType?: string | null;
  visaSignal?: string | null;
}): boolean {
  const text = `${input.jobTitle ?? ""} ${input.employmentType ?? ""} ${input.visaSignal ?? ""}`;
  return (
    /\b(contract(?:or)?|contract-to-hire|contract to hire|c2h|c2c|corp-to-corp|w2)\b/i.test(text) ||
    ["contract_likely", "contract_vendor_likely", "contract_no_sponsorship"].includes(
      input.visaSignal ?? "",
    )
  );
}

function answer(
  category: Extract<FieldCategory, "work_authorization" | "sponsorship_required">,
  label: string,
  value: "Yes" | "No",
  aliases: string[],
  reason: string,
): SavedAnswer {
  return {
    id: `derived:authorization:${category}`,
    normalizedQuestion: label.toLowerCase(),
    originalQuestion: label,
    category,
    answerValue: value,
    answerType: "text",
    sitePattern: "",
    domain: "",
    usageCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    riskLevel: "MEDIUM",
    notes: `Candidate-authorized conditional H-1B policy. ${reason}`,
    aliases,
  };
}

export function authorizationToSavedAnswers(input: {
  sponsorshipAnswer: string | null | undefined;
  matchingInstructions: string | null | undefined;
  jobTitle?: string | null;
  employmentType?: string | null;
  visaSignal?: string | null;
}): { answers: SavedAnswer[]; decision: AuthorizationDecision | null } {
  if (!usesContractNoSponsorshipPolicy(input.sponsorshipAnswer, input.matchingInstructions)) {
    return { answers: [], decision: null };
  }

  const isContractRole = contractRoleFromJob(input);
  const sponsorshipRequired = isContractRole ? "No" : "Yes";
  const reason = isContractRole
    ? "The posting is a contractor role, for which the candidate stated sponsorship is not required."
    : "The posting is not a contractor role, so H-1B sponsorship or transfer support is required.";

  return {
    answers: [
      answer(
        "work_authorization",
        "Work authorization",
        "Yes",
        ["authorized to work", "work authorization", "eligible to work"],
        "The candidate is currently authorized to work in the United States in H-1B status.",
      ),
      answer(
        "sponsorship_required",
        "Sponsorship required",
        sponsorshipRequired,
        ["sponsorship", "visa sponsorship", "require sponsorship", "future sponsorship"],
        reason,
      ),
    ],
    decision: {
      isContractRole,
      workAuthorization: "Yes",
      sponsorshipRequired,
      reason,
    },
  };
}
