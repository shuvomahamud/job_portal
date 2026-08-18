// Ported from BroswerExtension/src/types/index.ts — narrowed for worker formfill.
export const FIELD_CATEGORIES = [
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
  "work_authorization",
  "sponsorship_required",
  "expected_salary",
  "desired_rate",
  "notice_period",
  "willing_to_relocate",
  "remote_preference",
  "resume_upload",
  "cover_letter",
  "eeo_gender",
  "eeo_race",
  "eeo_disability",
  "eeo_veteran",
  "custom_short_answer",
  "custom_long_answer",
  "legal_background",
  "unknown"
] as const;

export type FieldCategory = (typeof FIELD_CATEGORIES)[number];
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type AnswerType =
  | "text"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "file";

export interface DetectedField {
  id: string;
  selector: string;
  tagName: string;
  inputType: string;
  labelText: string;
  normalizedQuestion: string;
  placeholder: string;
  ariaLabel: string;
  name: string;
  idAttribute: string;
  required: boolean;
  options: string[];
  currentValue: string;
  nearbyText: string;
  fieldCategory: FieldCategory;
  riskLevel: RiskLevel;
  confidence: number;
}

export interface SavedAnswer {
  id: string;
  normalizedQuestion: string;
  originalQuestion: string;
  category: FieldCategory;
  answerValue: string;
  answerType: AnswerType;
  optionValue?: string;
  sitePattern: string;
  domain: string;
  usageCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
  riskLevel: RiskLevel;
  notes: string;
  aliases: string[];
}

export type MatchType =
  | "exact"
  | "normalized"
  | "alias"
  | "retrieved"
  | "rule"
  | "ollama"
  | "manual";

export interface AnswerMatch {
  fieldId: string;
  savedAnswerId: string;
  matchType: MatchType;
  confidence: number;
  reason: string;
  requiresReview: boolean;
  optionValue?: string;
}

export interface FillAction {
  fieldId: string;
  value: string;
  actionType: "auto_fill" | "one_click_fill" | "manual_save" | "skip";
  status: "pending" | "filled" | "failed" | "skipped";
  reason?: string;
}

export interface FieldSuggestion {
  field: DetectedField;
  match?: AnswerMatch;
  savedAnswer?: SavedAnswer;
  suggestedValue: string;
  source: MatchType | "none";
  requiresReview: boolean;
  skipped?: boolean;
}



export interface MatchSettings {
  ollamaBaseUrl: string;
  ollamaAllowedRemoteHosts?: string[];
  ollamaRequestTimeoutMs?: number;
  ollamaKeepAlive?: string;
  selectedModel: string;
  autoFillConfidenceThreshold: number;
  allowAutoFillLowRisk: boolean;
  requireReviewMediumHigh: boolean;
  useOllamaForAmbiguous: boolean;
  allowOneClickSavedGender: boolean;
  allowOneClickSavedWorkEligibility: boolean;
}

/** @deprecated structural alias for ported modules */
export type ExtensionSettings = MatchSettings;




