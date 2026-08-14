import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fillDetectedField } from "../src/apply/fillField";
import { loadPlaywright } from "../src/browser/session";
import {
  detectFields,
  expandComboboxOptions,
  resolveFormRoot,
} from "../src/formfill/domDetector";

const sampleFormUrl = pathToFileURL(
  "/Users/shuvomahamud/Projects/BroswerExtension/examples/sample-application-form.html",
).href;

const expectedById: Record<string, string> = {
  "first-name": "first_name",
  "last-name": "last_name",
  email: "email",
  phone: "phone",
  linkedin: "linkedin",
  github: "github",
  city: "city",
  state: "state",
  "csharp-years": "years_csharp",
  "dotnet-years": "years_dotnet",
  "sql-years": "years_sql",
  "oracle-years": "years_oracle",
  // Radio group selector uses name; first control id is not on FieldBase as the group id.
  // Classified via legend text.
  sponsorship: "sponsorship_required",
  salary: "expected_salary",
  // Classifier has no rule for "when could you start a new role?" / name notice_period.
  availability: "unknown",
  "short-answer": "custom_short_answer",
  "long-answer": "custom_long_answer",
  resume: "resume_upload",
  gender: "eeo_gender",
};

test("detectFields classifies the donor sample application form", async () => {
  const playwright = await loadPlaywright();
  const userDataDir = await mkdtemp(join(tmpdir(), "searchlight-dom-"));
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(sampleFormUrl, { waitUntil: "domcontentloaded" });
    const { frame } = await resolveFormRoot(page, []);
    const fields = await detectFields(frame);

    const byId = Object.fromEntries(
      fields.filter((field) => field.idAttribute).map((field) => [field.idAttribute, field]),
    );

    for (const [id, category] of Object.entries(expectedById)) {
      assert.equal(byId[id]?.fieldCategory, category, `id=${id}`);
    }

    const workAuth = fields.find((field) => field.fieldCategory === "work_authorization");
    assert.ok(workAuth, "work_authorization radio group");
    assert.match(workAuth.labelText, /authorized to work/i);
    assert.deepEqual(workAuth.options, ["Yes", "No"]);

    const remote = fields.find((field) => field.fieldCategory === "remote_preference");
    assert.ok(remote, "remote_preference checkbox group");
    assert.deepEqual(remote.options, ["Remote", "Hybrid", "On-site"]);

    assert.deepEqual(byId.gender?.options, [
      "Woman",
      "Man",
      "Non-binary",
      "I do not wish to answer",
    ]);
    assert.equal(byId.resume?.fieldCategory, "resume_upload");

    // Every fillable control is represented (grouped radios/checkboxes count once).
    assert.equal(fields.length, Object.keys(expectedById).length + 2);

    const email = byId.email!;
    await fillDetectedField(frame, email, "candidate@example.com", {
      typingDelayMs: () => 0,
    });
    const value = await frame.evaluate(() => {
      const input = document.querySelector("#email") as HTMLInputElement | null;
      return input?.value ?? "";
    });
    assert.equal(value, "candidate@example.com");

    await fillDetectedField(frame, byId.gender!, "Non-binary", {
      typingDelayMs: () => 0,
    });
    assert.equal(
      await frame.evaluate(() =>
        (document.querySelector("#gender") as HTMLSelectElement | null)?.value ?? "",
      ),
      "Non-binary",
    );

    await fillDetectedField(frame, workAuth, "Yes", {
      typingDelayMs: () => 0,
    });
    assert.equal(
      await frame.evaluate(() =>
        (document.querySelector("#authorized-yes") as HTMLInputElement | null)?.checked ?? false,
      ),
      true,
    );
  } finally {
    await context.close();
  }
});

test("form detection reaches iframes and open shadow roots and expands collapsed comboboxes", async () => {
  const playwright = await loadPlaywright();
  const userDataDir = await mkdtemp(join(tmpdir(), "searchlight-dom-edge-"));
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    const iframeHtml = `<!doctype html><html><body>
      <label for="city">City</label><input id="city" name="city">
    </body></html>`;
    await page.goto(
      `data:text/html,${encodeURIComponent(`<iframe srcdoc="${iframeHtml.replaceAll('"', '&quot;')}"></iframe>`)}`,
      { waitUntil: "domcontentloaded" },
    );
    const iframeRoot = await resolveFormRoot(page, []);
    assert.equal(iframeRoot.isIframe, true);
    const iframeFields = await detectFields(iframeRoot.frame);
    assert.equal(iframeFields[0]?.fieldCategory, "city");

    const edgeHtml = `<!doctype html><html><body>
      <job-form></job-form>
      <label id="country-label">Country</label>
      <input id="country" role="combobox" aria-labelledby="country-label" aria-controls="country-options">
      <script>
        customElements.define("job-form", class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: "open" });
            root.innerHTML = '<label for="portfolio">Portfolio URL</label><input id="portfolio" name="portfolio_url">';
          }
        });
        document.querySelector("#country").addEventListener("click", () => {
          if (document.querySelector("#country-options")) return;
          const list = document.createElement("div");
          list.id = "country-options";
          list.setAttribute("role", "listbox");
          list.innerHTML = '<div role="option">United States</div><div role="option">Canada</div>';
          document.body.append(list);
        });
      </script>
    </body></html>`;
    await page.goto(`data:text/html,${encodeURIComponent(edgeHtml)}`, {
      waitUntil: "domcontentloaded",
    });
    const fields = await detectFields(page.mainFrame());
    assert.equal(
      fields.find((field) => field.idAttribute === "portfolio")?.fieldCategory,
      "portfolio",
    );
    const country = fields.find((field) => field.idAttribute === "country");
    assert.ok(country);
    assert.deepEqual(country.options, []);
    const expanded = await expandComboboxOptions(page.mainFrame(), fields);
    assert.deepEqual(
      expanded.find((field) => field.id === country.id)?.options,
      ["United States", "Canada"],
    );
  } finally {
    await context.close();
  }
});

test("an asterisk in the label marks a field required", async () => {
  // Indeed sets neither `required` nor `aria-required` on its screening questions and
  // marks the mandatory ones with a "*" in the text — its own contact page says "Fields
  // marked with (*) are required". Reading only the attributes made every one of them
  // look optional, so they were skipped in silence, nothing was ever asked of the user,
  // and the form simply would not advance.
  const playwright = await loadPlaywright();
  const userDataDir = await mkdtemp(join(tmpdir(), "searchlight-asterisk-"));
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(
      pathToFileURL(join(process.cwd(), "worker/tests/fixtures/asterisk-required.html")).href,
      { waitUntil: "domcontentloaded" },
    );
    const { frame } = await resolveFormRoot(page, []);
    const fields = await detectFields(frame);

    const required = (name: string) =>
      fields.find((field) => field.name === name || field.idAttribute === name)?.required;

    assert.equal(required("q_837ba9c5"), true, "starred question is required");
    assert.equal(required("zip"), true, "starred text field is required");
    assert.equal(required("q_80d7db28"), false, "an unstarred question stays optional");
    assert.equal(required("linkedin"), false, "an unstarred field stays optional");
  } finally {
    await context.close();
  }
});
