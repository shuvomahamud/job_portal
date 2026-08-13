/**
 * Shared with the worker so the dashboard and the form filler agree on which facts exist,
 * what they are called, and when one is trusted enough to auto-fill an application.
 */

/**
 * Only categories a resume can actually support. Identity fields (name, email, address)
 * stay in candidate_profile — the resume is not the source of truth for those.
 *
 * Every key here is LOW risk in the worker's riskPolicy, so a fact can auto-fill a field.
 * Sensitive categories (salary, sponsorship, EEO) are deliberately absent: those still
 * become questions under the existing always-review policy.
 */
export const FACT_KEYS = [
  "current_company",
  "current_title",
  "years_total_experience",
  "years_csharp",
  "years_dotnet",
  "years_sql",
  "years_oracle",
  "years_azure",
] as const;

export type FactKey = (typeof FACT_KEYS)[number];

/** Facts below this confidence are kept for review but never auto-fill a form. */
export const FACT_MIN_CONFIDENCE = 70;

export const FACT_LABELS: Record<FactKey, string> = {
  current_company: "Current company",
  current_title: "Current title",
  years_total_experience: "Years of total experience",
  years_csharp: "Years of C# experience",
  years_dotnet: "Years of .NET experience",
  years_sql: "Years of SQL experience",
  years_oracle: "Years of Oracle experience",
  years_azure: "Years of Azure experience",
};

export const YEARS_FACT_KEYS = new Set<string>([
  "years_total_experience",
  "years_csharp",
  "years_dotnet",
  "years_sql",
  "years_oracle",
  "years_azure",
]);

export function isFactKey(value: string): value is FactKey {
  return (FACT_KEYS as readonly string[]).includes(value);
}

export function factLabel(key: string): string {
  return isFactKey(key) ? FACT_LABELS[key] : key.replace(/_/g, " ");
}

/** Normalizes "7+ years" / "about 8" to a plain integer; null when not a usable number. */
export function normalizeYearsValue(raw: string): string | null {
  const match = raw.match(/\d+(\.\d+)?/);
  if (!match) return null;
  const rounded = Math.floor(Number(match[0]));
  if (!Number.isFinite(rounded) || rounded < 0 || rounded > 60) return null;
  return String(rounded);
}

/** True when a fact is trusted enough to fill a real application field. */
export function factIsUsable(fact: { confidence: number; verified: boolean }): boolean {
  return fact.verified || fact.confidence >= FACT_MIN_CONFIDENCE;
}
