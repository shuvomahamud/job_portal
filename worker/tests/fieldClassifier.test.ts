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

test("classifyField treats unknown textareas as long answers", () => {
  assert.equal(classifyField(field("Tell us your story", "textarea")).category, "custom_long_answer");
});

test("classifyField recognizes work-arrangement checkbox options", () => {
  const result = classifyField({
    ...field("Which work arrangements are acceptable?"),
    options: ["Remote", "Hybrid", "On-site"],
  });
  assert.equal(result.category, "remote_preference");
  assert.equal(result.confidence, 0.95);
});
