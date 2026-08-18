import assert from "node:assert/strict";
import test from "node:test";
import { classifyField } from "../src/formfill/fieldClassifier";

function field(labelText: string, inputType = "text") {
  return {
    labelText,
    normalizedQuestion: labelText.toLowerCase(),
    placeholder: "",
    ariaLabel: "",
    name: "",
    idAttribute: "",
    nearbyText: "",
    inputType,
    tagName: inputType === "textarea" ? "textarea" : "input",
  };
}

test("classifyField uses semantic HTML types first", () => {
  assert.equal(classifyField(field("Contact", "email")).category, "email");
  assert.equal(classifyField(field("Contact", "tel")).category, "phone");
});

const cases: Array<[string, string]> = [
  ["Do you require H-1B sponsorship?", "sponsorship_required"],
  ["Are you authorized to work in the US?", "work_authorization"],
  ["Years of C# experience", "years_csharp"],
  ["Years of .NET experience", "years_dotnet"],
  ["SQL experience in years", "years_sql"],
  ["Oracle experience in years", "years_oracle"],
  ["Expected compensation", "expected_salary"],
  ["Veteran status", "eeo_veteran"],
  ["Have you been convicted of a felony?", "legal_background"],
];

for (const [label, expected] of cases) {
  test(`classifyField classifies ${label} as ${expected}`, () => {
    assert.equal(classifyField(field(label)).category, expected);
  });
}

test("classifyField treats combined school / city / degree as a short answer", () => {
  assert.equal(classifyField(field("University, City & State, Degree")).category, "custom_short_answer");
  assert.equal(classifyField(field("Graduate School, City & State, Degree")).category, "custom_short_answer");
  assert.equal(classifyField(field("Trade School, City & State, Degree")).category, "custom_short_answer");
});

test("classifyField treats marketing email opt-in as a short answer, not email", () => {
  const result = classifyField(
    field("Would you like to opt-in to receive email notifications about new jobs?"),
  );
  assert.equal(result.category, "custom_short_answer");
  assert.equal(classifyField(field("Email address")).category, "email");
});

test("classifyField treats years of remote work as a short answer, not location preference", () => {
  assert.equal(
    classifyField(field("How many years of remote work experience do you have?")).category,
    "custom_short_answer",
  );
});

test("classifyField recognizes work-arrangement checkbox options", () => {
  const result = classifyField({
    ...field("Which work arrangements are acceptable?"),
    options: ["Remote", "Hybrid", "On-site"],
  });
  assert.equal(result.category, "remote_preference");
  assert.equal(result.confidence, 0.95);
});
