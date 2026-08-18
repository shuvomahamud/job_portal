// Ported from BroswerExtension/src/lib/fieldClassifier.ts — keep byte-identical aside from this provenance line.
import type { DetectedField, FieldCategory } from "./types";

export interface Classification {
  category: FieldCategory;
  confidence: number;
  reason: string;
}

type ClassifiableField = Pick<
  DetectedField,
  | "labelText"
  | "normalizedQuestion"
  | "placeholder"
  | "ariaLabel"
  | "name"
  | "idAttribute"
  | "nearbyText"
  | "inputType"
  | "tagName"
> & { options?: string[] };

function result(
  category: FieldCategory,
  confidence: number,
  reason: string
): Classification {
  return { category, confidence, reason };
}

export function classifyField(field: ClassifiableField): Classification {
  const primaryText = [
    field.labelText,
    field.normalizedQuestion,
    field.placeholder,
    field.ariaLabel,
    field.name,
    field.idAttribute
  ]
    .join(" ")
    .toLowerCase();
  const text =
    primaryText.replace(/\bunlabeled field\b/g, "").trim().length > 2
      ? primaryText
      : `${primaryText} ${field.nearbyText.toLowerCase()}`;
  const optionText = (field.options ?? []).join(" ").toLowerCase();
  const inputType = field.inputType.toLowerCase();

  if (inputType === "password") return result("unknown", 1, "Password fields are excluded.");
  if (inputType === "email") return result("email", 0.99, "HTML email field.");
  if (inputType === "tel") return result("phone", 0.99, "HTML telephone field.");
  if (inputType === "file" || /\b(upload|attach).*(resume|cv)\b|\b(resume|cv).*(upload|attach)\b/.test(text)) {
    return result("resume_upload", 0.99, "Resume file upload field.");
  }
  if (/\bfirst[\s_-]*name\b|\bgiven[\s_-]*name\b/.test(text)) {
    return result("first_name", 0.98, "First-name label.");
  }
  if (/\blast[\s_-]*name\b|\bsur[\s_-]*name\b|\bfamily[\s_-]*name\b/.test(text)) {
    return result("last_name", 0.98, "Last-name label.");
  }
  if (/\bfull[\s_-]*name\b|\byour name\b|\bcandidate name\b/.test(text)) {
    return result("full_name", 0.95, "Full-name label.");
  }
  if (
    /\bopt[\s-]?in\b/.test(text) ||
    (/\be[\s_-]*mail notifications?\b/.test(text) &&
      /\b(receive|new jobs|marketing|subscribe)\b/.test(text))
  ) {
    return result("custom_short_answer", 0.92, "Marketing or job-alert opt-in, not an email address.");
  }
  if (/\be[\s_-]*mail\b/.test(text)) return result("email", 0.98, "Email label.");
  if (/\b(phone|telephone|mobile|cell)\b/.test(text)) {
    return result("phone", 0.97, "Phone label.");
  }
  if (/\blinked[\s_-]*in\b/.test(text)) {
    return result("linkedin", 0.99, "LinkedIn profile label.");
  }
  if (/\bgit[\s_-]*hub\b/.test(text)) return result("github", 0.99, "GitHub profile label.");
  if (/\b(portfolio|personal website|website url)\b/.test(text)) {
    return result("portfolio", 0.94, "Portfolio or website label.");
  }
  if (/\b(street|mailing|home)[\s_-]*address\b|\baddress line\b/.test(text)) {
    return result("address", 0.94, "Address label.");
  }
  if (
    /\b(trade school|graduate school|high school|university|college)\b/.test(text) &&
    /\bdegree\b/.test(text)
  ) {
    return result("custom_short_answer", 0.86, "Combined school / city / degree field.");
  }
  if (/\bcity\b/.test(text)) return result("city", 0.93, "City label.");
  if (/\b(state|province|region)\b/.test(text)) return result("state", 0.9, "State or region label.");
  if (/\b(zip|postal|postcode)\b/.test(text)) return result("zip", 0.96, "Postal code label.");
  if (/\bcountry\b/.test(text)) return result("country", 0.96, "Country label.");
  if (/\bcurrent company\b|\bcurrent employer\b|\bemployer name\b/.test(text)) {
    return result("current_company", 0.93, "Current employer label.");
  }
  if (/\bcurrent (job )?title\b|\bcurrent position\b/.test(text)) {
    return result("current_title", 0.93, "Current title label.");
  }
  if (/\b(years?|yrs?).*\b(c#|csharp|c sharp)\b|\b(c#|csharp|c sharp).*\b(years?|yrs?)\b/.test(text)) {
    return result("years_csharp", 0.98, "C# experience question.");
  }
  if (/\b(years?|yrs?).*(?:\.net\b|\bdotnet\b|\bdot net\b)|(?:\.net\b|\bdotnet\b|\bdot net\b).*\b(years?|yrs?)\b/.test(text)) {
    return result("years_dotnet", 0.98, ".NET experience question.");
  }
  if (/\b(years?|yrs?).*\bsql\b|\bsql.*\b(years?|yrs?)\b/.test(text)) {
    return result("years_sql", 0.97, "SQL experience question.");
  }
  if (/\b(years?|yrs?).*\boracle\b|\boracle.*\b(years?|yrs?)\b/.test(text)) {
    return result("years_oracle", 0.97, "Oracle experience question.");
  }
  if (/\b(years?|yrs?).*\bazure\b|\bazure.*\b(years?|yrs?)\b/.test(text)) {
    return result("years_azure", 0.97, "Azure experience question.");
  }
  if (/\b(total|overall).*\b(years?|experience)\b|\byears? of (professional )?experience\b/.test(text)) {
    return result("years_total_experience", 0.9, "Total experience question.");
  }
  if (/\b(sponsor|sponsorship|h[\s-]?1b|visa)\b/.test(text)) {
    return result("sponsorship_required", 0.97, "Employment sponsorship question.");
  }
  if (/\b(authorized|authorised|authorization|eligible).*\bwork\b|\bwork.*\b(authorized|authorised|authorization|eligible)\b/.test(text)) {
    return result("work_authorization", 0.96, "Work authorization question.");
  }
  if (/\b(hourly|daily|desired).*\b(rate|compensation)\b|\brate expectation\b/.test(text)) {
    return result("desired_rate", 0.91, "Desired rate question.");
  }
  if (/\b(salary|compensation|pay expectation|expected pay)\b/.test(text)) {
    return result("expected_salary", 0.92, "Salary expectation question.");
  }
  if (/\bnotice period\b|\bavailable to start\b|\bstart date\b/.test(text)) {
    return result("notice_period", 0.9, "Availability or notice-period question.");
  }
  if (/\brelocat(e|ion)\b/.test(text)) {
    return result("willing_to_relocate", 0.94, "Relocation question.");
  }
  if (/\b(years?|yrs?).*\bremote\b|\bremote.*\b(years?|yrs?)\b/.test(text)) {
    return result("custom_short_answer", 0.9, "Years of remote work, not a location preference.");
  }
  if (
    /\b(work arrangement|work location|location preference|remote preference)\b/.test(text) ||
    /\b(remote|hybrid|onsite|on site)\b/.test(text) ||
    (/\bremote\b/.test(optionText) &&
      /\b(hybrid|onsite|on site)\b/.test(optionText))
  ) {
    return result("remote_preference", 0.95, "Work-location preference.");
  }
  if (/\bcover letter\b/.test(text)) return result("cover_letter", 0.96, "Cover letter field.");
  if (/\b(disability|disabled)\b/.test(text)) return result("eeo_disability", 0.98, "Disability disclosure.");
  if (/\b(veteran|military status)\b/.test(text)) return result("eeo_veteran", 0.98, "Veteran disclosure.");
  if (/\b(race|ethnicity|ethnic)\b/.test(text)) return result("eeo_race", 0.98, "Race or ethnicity disclosure.");
  if (/\b(gender|sex)\b/.test(text)) return result("eeo_gender", 0.96, "Gender disclosure.");
  if (/\b(criminal|convict|felony|misdemeanor|background check|legal proceeding)\b/.test(text)) {
    return result("legal_background", 0.96, "Legal or background question.");
  }
  if (field.tagName.toLowerCase() === "textarea") {
    return result("custom_long_answer", 0.64, "Unrecognized long-form answer.");
  }
  if (["text", "url", "number", "search", ""].includes(inputType)) {
    return result("custom_short_answer", 0.55, "Unrecognized short answer.");
  }
  return result("unknown", 0.3, "No deterministic category rule matched.");
}
