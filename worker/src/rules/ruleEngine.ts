import type { NormalizedJobInput, Priority } from "../types";

export type RuleFilterDecision = "apply" | "maybe" | "skip";

export type RuleFilterResult = {
  score: number;
  priority: Priority;
  status: "needs_review" | "ready_to_apply" | "archived";
  recommendation: RuleFilterDecision;
  strengths: string[];
  gaps: string[];
  visaSignal: string;
  visaNotes: string;
  techStack: string[];
  remoteType: string | null;
  employmentType: string | null;
  salaryText: string | null;
  resumeAngle: string;
  notes: string;
  matchedPositiveRules: string[];
  matchedNegativeRules: string[];
};

type RulePattern = { label: string; patterns: RegExp[]; score: number; tech?: string };

const positiveRules: RulePattern[] = [
  { label: ".NET", patterns: [/\.net\b/i, /dotnet/i, /asp\.net/i], score: 18, tech: ".NET" },
  { label: "C#", patterns: [/c#/i, /c sharp/i], score: 16, tech: "C#" },
  { label: "SQL", patterns: [/\bsql\b/i, /sql server/i, /t-sql/i, /tsql/i], score: 12, tech: "SQL" },
  { label: "Oracle", patterns: [/\boracle\b/i, /pl\/sql/i], score: 10, tech: "Oracle" },
  { label: "application support", patterns: [/application support/i, /production support/i, /support analyst/i], score: 14 },
  { label: "full stack", patterns: [/full[- ]?stack/i, /backend.*frontend/i], score: 8 },
  { label: "Azure", patterns: [/\bazure\b/i, /app service/i], score: 8, tech: "Azure" },
  { label: "React/Angular", patterns: [/\breact\b/i, /\bangular\b/i], score: 6 },
  { label: "contract fit", patterns: [/contract/i, /contract-to-hire/i, /c2h/i, /w2 contract/i, /corp-to-corp/i, /c2c/i], score: 8 },
  { label: "staffing/vendor likely", patterns: [/staffing/i, /recruiter/i, /consulting/i, /implementation partner/i, /vendor/i, /talent solutions/i], score: 7 },
  { label: "remote/hybrid", patterns: [/\bremote\b/i, /\bhybrid\b/i], score: 5 },
];

const negativeRules: RulePattern[] = [
  { label: "citizen only", patterns: [/u\.?s\.? citizens? only/i, /citizenship required/i, /must be a us citizen/i], score: -55 },
  { label: "GC/USC only", patterns: [/\b(gc|green card)\s*(\/|or)?\s*(usc|u\.?s\.? citizen)/i, /usc\s*(\/|or)?\s*gc/i], score: -55 },
  { label: "clearance required", patterns: [/security clearance/i, /active clearance/i, /secret clearance/i, /top secret/i], score: -45 },
  { label: "no sponsorship", patterns: [/no sponsorship/i, /unable to sponsor/i, /cannot sponsor/i, /without sponsorship/i, /will not sponsor/i], score: -50 },
  { label: "unrelated Java-only", patterns: [/java developer/i, /spring boot/i], score: -18 },
  { label: "unrelated Python-only", patterns: [/python developer/i, /django/i, /flask/i], score: -14 },
  { label: "architect-heavy", patterns: [/principal architect/i, /enterprise architect/i, /solutions architect/i], score: -16 },
  { label: "DevOps-only", patterns: [/devops engineer/i, /kubernetes engineer/i, /site reliability engineer/i, /\bsre\b/i], score: -16 },
  { label: "commission/unpaid", patterns: [/commission only/i, /unpaid/i, /equity only/i], score: -50 },
  { label: "too senior", patterns: [/15\+ years/i, /20\+ years/i], score: -12 },
];

const techPatterns: Array<[string, RegExp[]]> = [
  [".NET", [/\.net\b/i, /asp\.net/i, /dotnet/i]],
  ["C#", [/c#/i, /c sharp/i]],
  ["SQL", [/\bsql\b/i, /sql server/i, /t-sql/i]],
  ["Oracle", [/\boracle\b/i, /pl\/sql/i]],
  ["Azure", [/\bazure\b/i]],
  ["React", [/\breact\b/i]],
  ["Angular", [/\bangular\b/i]],
  ["JavaScript", [/javascript/i, /\bjs\b/i]],
  ["TypeScript", [/typescript/i]],
  ["HTML/CSS", [/html/i, /css/i]],
  ["REST API", [/rest api/i, /web api/i]],
  ["Entity Framework", [/entity framework/i, /\bef core\b/i]],
  ["IIS", [/\biis\b/i]],
  ["Production Support", [/production support/i, /application support/i]],
];

function includesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function detectVisaSignal(text: string): { signal: string; notes: string; penalty: number } {
  if (/u\.?s\.? citizens? only|citizenship required|must be a us citizen/i.test(text)) {
    return { signal: "citizen_only", notes: "Job appears to require U.S. citizenship; skip for H-1B transfer search.", penalty: 55 };
  }
  if (/\b(gc|green card)\s*(\/|or)?\s*(usc|u\.?s\.? citizen)|usc\s*(\/|or)?\s*gc/i.test(text)) {
    return { signal: "gc_usc_only", notes: "Job appears limited to GC/USC candidates; skip for H-1B transfer search.", penalty: 55 };
  }
  if (/security clearance|active clearance|secret clearance|top secret/i.test(text)) {
    return { signal: "clearance_required", notes: "Job appears to require security clearance; skip unless manually confirmed otherwise.", penalty: 45 };
  }
  if (/no sponsorship|no visa sponsorship|visa sponsorship is not available|sponsorship is not available|do not provide visa sponsorship|unable to sponsor|cannot sponsor|without sponsorship|will not sponsor|requiring visa sponsorship will not be considered/i.test(text)) {
    return { signal: "no_sponsorship", notes: "Job says sponsorship is not available; skip for H-1B transfer search.", penalty: 50 };
  }
  if (/h-?1b transfer/i.test(text)) {
    return { signal: "h1b_transfer_explicit", notes: "H-1B transfer is explicitly mentioned.", penalty: 0 };
  }
  if (/sponsorship.*available|visa sponsorship|will sponsor|sponsor.*visa/i.test(text)) {
    return { signal: "sponsorship_available", notes: "Sponsorship or visa support appears available; still verify before applying.", penalty: 0 };
  }
  if (/\b(contract|contract-to-hire|c2h|c2c|corp-to-corp|w2)\b/i.test(text) && /staffing|recruiter|consulting|vendor|talent solutions|implementation partner/i.test(text)) {
    return { signal: "contract_vendor_likely", notes: "Contract/vendor/staffing signals make this likely worth review for H-1B/contract fit.", penalty: 0 };
  }
  if (/\b(contract|contract-to-hire|c2h|c2c|corp-to-corp|w2)\b/i.test(text)) {
    return { signal: "contract_likely", notes: "Contract language is present; verify work-authorization details before applying.", penalty: 0 };
  }
  return { signal: "unknown", notes: "No clear visa/sponsorship signal found; do not auto-apply without manual review unless other evidence is strong.", penalty: 0 };
}

function detectRemoteType(text: string, existing?: string | null) {
  if (existing) return existing;
  if (/\bremote\b/i.test(text)) return "remote";
  if (/\bhybrid\b/i.test(text)) return "hybrid";
  if (/on[- ]?site|onsite/i.test(text)) return "onsite";
  return null;
}

function detectEmploymentType(text: string, existing?: string | null) {
  if (existing) return existing;
  if (/contract-to-hire|contract to hire|c2h/i.test(text)) return "contract-to-hire";
  if (/contract|corp-to-corp|c2c|w2/i.test(text)) return "contract";
  if (/full[- ]?time|permanent/i.test(text)) return "full-time";
  if (/part[- ]?time/i.test(text)) return "part-time";
  return null;
}

function detectSalary(text: string, existing?: string | null) {
  if (existing) return existing;
  const match = text.match(/(?:\$\s?\d{2,3}(?:,\d{3})?(?:\s?[-–]\s?\$?\d{2,3}(?:,\d{3})?)?\s?(?:\/\s?hr|per hour|hourly|k|annually|year|yr)?)/i);
  return match?.[0] ?? null;
}

export function evaluateJob(job: NormalizedJobInput & { id?: string }): RuleFilterResult {
  const text = [job.title, job.company, job.location, job.description, job.notes, job.salaryText, job.employmentType, job.remoteType]
    .filter(Boolean)
    .join("\n");

  let score = 35;
  const strengths: string[] = [];
  const gaps: string[] = [];
  const matchedPositiveRules: string[] = [];
  const matchedNegativeRules: string[] = [];

  for (const rule of positiveRules) {
    if (includesAny(text, rule.patterns)) {
      score += rule.score;
      matchedPositiveRules.push(rule.label);
      strengths.push(rule.label);
    }
  }

  for (const rule of negativeRules) {
    if (includesAny(text, rule.patterns)) {
      score += rule.score;
      matchedNegativeRules.push(rule.label);
      gaps.push(rule.label);
    }
  }

  const techStack = unique([
    ...(job.techStack ?? []),
    ...techPatterns.filter(([, patterns]) => includesAny(text, patterns)).map(([tech]) => tech),
  ]);

  if (!techStack.some((tech) => [".NET", "C#", "SQL", "Oracle", "Production Support"].includes(tech))) {
    score -= 18;
    gaps.push("No strong match to target .NET/C#/SQL/Oracle/support stack.");
  }

  const visa = detectVisaSignal(text);
  score -= visa.penalty;

  const hasTargetStack = techStack.some((tech) => [".NET", "C#", "SQL", "Oracle", "Production Support"].includes(tech));
  const hasSupportOrDotnet = techStack.some((tech) => [".NET", "C#", "Production Support"].includes(tech)) || /application support|production support|\.net|asp\.net|c#/i.test(text);
  const disqualifyingVisa = ["citizen_only", "gc_usc_only", "clearance_required", "no_sponsorship"].includes(visa.signal);
  const contractFriendly = ["h1b_transfer_explicit", "sponsorship_available", "contract_vendor_likely", "contract_likely"].includes(visa.signal);
  const fullTimeUnknown = detectEmploymentType(text, job.employmentType) === "full-time" && visa.signal === "unknown";

  if (contractFriendly && hasSupportOrDotnet) {
    score += visa.signal === "contract_likely" ? 4 : 8;
    strengths.push("H-1B/contract path looks possible");
  }
  if (fullTimeUnknown) {
    score -= 10;
    gaps.push("Full-time role with unknown sponsorship; manual review required before applying.");
  }
  if (disqualifyingVisa) {
    gaps.push("Work-authorization disqualifier for H-1B transfer search.");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let recommendation: RuleFilterDecision = score >= 72 ? "apply" : score >= 50 ? "maybe" : "skip";
  if (disqualifyingVisa || !hasTargetStack) recommendation = "skip";
  else if (score >= 72 && !contractFriendly) recommendation = "maybe";
  else if (fullTimeUnknown) recommendation = "maybe";

  const status = recommendation === "apply" ? "ready_to_apply" : recommendation === "maybe" ? "needs_review" : "archived";
  const priority: Priority = recommendation === "apply" && score >= 82 ? "high" : score >= 60 ? "normal" : "low";

  return {
    score,
    priority,
    status,
    recommendation,
    strengths: unique(strengths).slice(0, 12),
    gaps: unique(gaps).slice(0, 12),
    visaSignal: visa.signal,
    visaNotes: visa.notes,
    techStack,
    remoteType: detectRemoteType(text, job.remoteType),
    employmentType: detectEmploymentType(text, job.employmentType),
    salaryText: detectSalary(text, job.salaryText),
    resumeAngle: buildResumeAngle(techStack, recommendation),
    notes: `Rule filter: ${recommendation}; score ${score}. H-1B/contract signal: ${visa.signal}. ${visa.notes} Positives: ${unique(matchedPositiveRules).join(", ") || "none"}. Concerns: ${unique(matchedNegativeRules).join(", ") || "none"}.`,
    matchedPositiveRules: unique(matchedPositiveRules),
    matchedNegativeRules: unique(matchedNegativeRules),
  };
}

function buildResumeAngle(techStack: string[], recommendation: RuleFilterDecision) {
  const focus = techStack.filter((tech) => [".NET", "C#", "SQL", "Oracle", "Azure", "Production Support"].includes(tech));
  if (focus.length) return `Emphasize ${focus.slice(0, 5).join(", ")} experience and application-support outcomes.`;
  if (recommendation === "skip") return "Low target-stack match; do not tailor unless manually selected.";
  return "Emphasize full-stack/app-support experience and production troubleshooting.";
}
