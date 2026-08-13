import type { CandidateMatchingContext, JobMatchingContext } from "./matchSchema";

export type HardFilterResult =
  | { eligible: true }
  | { eligible: false; score: number; visaSignal: string; reasons: string[] };

function needsSponsorship(candidate: CandidateMatchingContext) {
  const answer = `${candidate.workAuthorizationAnswer} ${candidate.sponsorshipAnswer}`.toLowerCase();
  if (!answer) return false;
  if (!/h-?1b|sponsor|sponsorship|transfer|require(?:s|d)?\s+(?:visa\s+)?sponsor/.test(answer)) {
    return false;
  }
  // A profile carrying the contract-alternative marker is stating a conditional:
  // sponsorship is needed in general, and contract work is the single exception. Its
  // "do not require sponsorship for contract roles" clause is scoped to that exception,
  // but this check reads the whole answer as one string, so without this guard the scoped
  // clause clears the global need and every permanent role refusing sponsorship sails
  // through the filter. The contract exception is applied later, per posting.
  if (allowsAuthorizedContractAlternative(candidate)) return true;
  return !/do not require|does not require|no sponsorship required|not require sponsorship/.test(
    answer,
  );
}

const AUTHORIZED_CONTRACT_MARKER = "[authorized-contract-alternative]";

function allowsAuthorizedContractAlternative(candidate: CandidateMatchingContext) {
  return `${candidate.sponsorshipAnswer} ${candidate.matchingInstructions ?? ""}`
    .toLowerCase()
    .includes(AUTHORIZED_CONTRACT_MARKER);
}

function isContractOpportunity(text: string) {
  return /\b(contract(?:or)?|contract-to-hire|contract to hire|c2h|c2c|corp-to-corp|w2)\b/.test(text);
}

function candidateClaimsCitizenship(candidate: CandidateMatchingContext) {
  return /u\.?s\.?\s*citizen|united states citizen/i.test(`${candidate.workAuthorizationAnswer} ${candidate.summary}`);
}

function candidateClaimsClearance(candidate: CandidateMatchingContext) {
  return /(?:active |current )?(?:secret|top secret|ts\/sci|security) clearance/i.test(`${candidate.summary} ${candidate.matchingInstructions ?? ""}`);
}

function isMeaningfulJob(job: JobMatchingContext) {
  const fallbackTitle = /discovered job|untitled role/i.test(job.title);
  const fallbackCompany = /browser discovery|unknown company/i.test(job.company);
  const invalidDescription =
    job.description.length < 400 ||
    /captcha|access denied|sign in to continue|job has expired|no longer available|verify you are human/i.test(job.description);
  return !fallbackTitle && !fallbackCompany && !invalidDescription;
}

export function evaluateProfileHardFilter(candidate: CandidateMatchingContext, job: JobMatchingContext): HardFilterResult {
  if (!isMeaningfulJob(job)) {
    return { eligible: false, score: 0, visaSignal: "invalid_job", reasons: ["The posting does not contain enough valid job detail for safe matching."] };
  }

  const text = `${job.title}\n${job.location ?? ""}\n${job.employmentType ?? ""}\n${job.description}`.toLowerCase();
  const reasons: string[] = [];
  let visaSignal = "unknown";

  if (/u\.?s\.? citizens? only|citizenship required|must be a us citizen/.test(text) && !candidateClaimsCitizenship(candidate)) {
    reasons.push("The posting explicitly requires U.S. citizenship, which the profile does not confirm.");
    visaSignal = "citizen_only";
  }
  if (/security clearance|active clearance|secret clearance|top secret/.test(text) && !candidateClaimsClearance(candidate)) {
    reasons.push("The posting requires a security clearance that the profile does not confirm.");
    visaSignal = "clearance_required";
  }
  if (/no sponsorship|no visa sponsorship|visa sponsorship is not available|sponsorship is not available|do not provide visa sponsorship|unable to sponsor|cannot sponsor|without sponsorship|will not sponsor|requiring visa sponsorship will not be considered/.test(text) && needsSponsorship(candidate)) {
    const contractAlternative =
      allowsAuthorizedContractAlternative(candidate) && isContractOpportunity(text);
    if (!contractAlternative) {
      reasons.push("The posting says sponsorship is unavailable while the profile indicates sponsorship or transfer is needed.");
      visaSignal = "no_sponsorship";
    }
  }

  for (const dealBreaker of candidate.dealBreakers) {
    const normalized = dealBreaker.trim().toLowerCase();
    if (normalized.length >= 4 && text.includes(normalized)) {
      reasons.push(`The posting matches the profile deal breaker: ${dealBreaker}.`);
    }
  }

  if (reasons.length) return { eligible: false, score: 0, visaSignal, reasons };
  return { eligible: true };
}
