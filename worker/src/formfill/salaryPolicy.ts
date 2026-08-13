import type { FieldCategory } from "./types";

export type SalaryPeriod = "annual" | "hourly";

export type SalaryRecommendation = {
  value: string;
  period: SalaryPeriod;
  minimum: number;
  maximum: number;
  target: number;
  reason: string;
};

const UPPER_RANGE_POSITION = 0.85;

export const POSTED_RANGE_SALARY_POLICY_MARKER = "[auto-posted-range-upper-85]";

export function usesPostedRangeSalaryPolicy(value: string | null | undefined): boolean {
  return value?.toLowerCase().includes(POSTED_RANGE_SALARY_POLICY_MARKER) ?? false;
}

function salaryPeriod(text: string, values: number[]): SalaryPeriod | null {
  if (/\b(hourly|per\s+hour)\b|\/\s*(?:hr|hour)\b/i.test(text)) return "hourly";
  if (/\b(annual|annually|yearly|per\s+year|a\s+year|salary)\b|\/\s*yr\b/i.test(text)) {
    return "annual";
  }
  if (/\d\s*k\b/i.test(text) || Math.max(...values) >= 10_000) return "annual";
  if (Math.max(...values) <= 500) return "hourly";
  return null;
}

function amounts(text: string): number[] {
  const values: number[] = [];
  const pattern = /(?:[$£€]\s*|\bUSD\s+)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const raw = Number(match[1]!.replace(/,/g, ""));
    if (!Number.isFinite(raw)) continue;
    values.push(match[2] ? raw * 1_000 : raw);
  }
  return values.slice(0, 2);
}

function plausible(value: number, period: SalaryPeriod): boolean {
  return period === "annual"
    ? value >= 30_000 && value <= 1_000_000
    : value >= 10 && value <= 1_000;
}

function roundedTarget(minimum: number, maximum: number, period: SalaryPeriod): number {
  const raw = minimum + (maximum - minimum) * UPPER_RANGE_POSITION;
  const unit = period === "annual" ? 1_000 : 1;
  return Math.min(maximum, Math.round(raw / unit) * unit);
}

/**
 * Converts a posting's explicit pay range into the candidate-authorized target answer.
 * It never invents a market rate: missing, malformed, or period-incompatible pay data
 * returns null so the normal pending-question notification path takes over.
 */
export function recommendSalaryAnswer(
  salaryText: string | null | undefined,
  category: Extract<FieldCategory, "expected_salary" | "desired_rate">,
): SalaryRecommendation | null {
  const text = salaryText?.trim();
  if (!text) return null;

  const parsed = amounts(text);
  if (!parsed.length) return null;
  const period = salaryPeriod(text, parsed);
  if (!period) return null;
  if (category === "expected_salary" && period !== "annual") return null;
  if (category === "desired_rate" && period !== "hourly") return null;

  const minimum = Math.min(...parsed);
  const maximum = Math.max(...parsed);
  if (!plausible(minimum, period) || !plausible(maximum, period)) return null;

  const target = roundedTarget(minimum, maximum, period);
  const unit = period === "annual" ? "annual" : "hourly";
  return {
    value: String(target),
    period,
    minimum,
    maximum,
    target,
    reason:
      minimum === maximum
        ? `Used the posting's explicit ${unit} pay figure.`
        : `Selected a rounded target 85% toward the top of the posting's ${unit} pay range, without exceeding its maximum.`,
  };
}
