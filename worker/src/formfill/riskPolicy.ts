// Ported from BroswerExtension/src/lib/riskPolicy.ts — keep byte-identical aside from this provenance line.
import type {
  AnswerMatch,
  DetectedField,
  ExtensionSettings,
  FieldCategory,
  RiskLevel,
  SavedAnswer
} from "./types";

const LOW_RISK = new Set<FieldCategory>([
  "first_name",
  "last_name",
  "full_name",
  "email",
  "phone",
  "address",
  "city",
  "state",
  "zip",
  "country",
  "linkedin",
  "github",
  "portfolio",
  "current_company",
  "current_title",
  "years_total_experience",
  "years_csharp",
  "years_dotnet",
  "years_sql",
  "years_oracle",
  "years_azure",
  "remote_preference"
]);

const MEDIUM_RISK = new Set<FieldCategory>([
  "work_authorization",
  "sponsorship_required",
  "expected_salary",
  "desired_rate",
  "notice_period",
  "willing_to_relocate",
  "resume_upload",
  "custom_short_answer"
]);

export function getRiskLevel(category: FieldCategory, confidence = 1): RiskLevel {
  if (confidence < 0.6 || category === "unknown") return "HIGH";
  if (LOW_RISK.has(category)) return "LOW";
  if (MEDIUM_RISK.has(category)) return "MEDIUM";
  return "HIGH";
}

export function categoryAlwaysRequiresReview(category: FieldCategory): boolean {
  return [
    "sponsorship_required",
    "expected_salary",
    "desired_rate",
    "eeo_gender",
    "eeo_race",
    "eeo_disability",
    "eeo_veteran",
    "legal_background",
    "custom_long_answer"
  ].includes(category);
}

export function requiresReview(
  field: Pick<DetectedField, "fieldCategory" | "riskLevel" | "confidence">,
  matchConfidence: number,
  settings?: Pick<
    ExtensionSettings,
    "autoFillConfidenceThreshold" | "requireReviewMediumHigh"
  >
): boolean {
  const threshold = settings?.autoFillConfidenceThreshold ?? 0.88;
  if (categoryAlwaysRequiresReview(field.fieldCategory)) return true;
  if (field.confidence < threshold || matchConfidence < threshold) return true;
  if (settings?.requireReviewMediumHigh !== false && field.riskLevel !== "LOW") {
    return true;
  }
  return false;
}

export function canFillSafely(
  field: Pick<DetectedField, "fieldCategory" | "riskLevel" | "confidence">,
  matchConfidence: number,
  settings: ExtensionSettings
): boolean {
  return (
    field.riskLevel === "LOW" &&
    !categoryAlwaysRequiresReview(field.fieldCategory) &&
    field.confidence >= settings.autoFillConfidenceThreshold &&
    matchConfidence >= settings.autoFillConfidenceThreshold
  );
}

export function canUseUserApprovedSafeAnswer(
  field: Pick<DetectedField, "fieldCategory" | "inputType">,
  match: Pick<AnswerMatch, "matchType" | "confidence">,
  answer: Pick<SavedAnswer, "riskLevel">,
  settings: ExtensionSettings
): boolean {
  const trustedGender =
    field.fieldCategory === "eeo_gender" &&
    settings.allowOneClickSavedGender;
  const trustedWorkEligibility =
    ["work_authorization", "sponsorship_required"].includes(
      field.fieldCategory
    ) && settings.allowOneClickSavedWorkEligibility;
  const trustedDirectAnswer = trustedGender || trustedWorkEligibility;
  const allowedMatchTypes = trustedDirectAnswer
    ? ["exact", "normalized", "alias", "rule"]
    : ["exact", "normalized", "alias"];
  return (
    (answer.riskLevel === "LOW" || trustedDirectAnswer) &&
    field.inputType !== "file" &&
    (!categoryAlwaysRequiresReview(field.fieldCategory) ||
      trustedDirectAnswer) &&
    allowedMatchTypes.includes(match.matchType) &&
    match.confidence >= settings.autoFillConfidenceThreshold
  );
}
