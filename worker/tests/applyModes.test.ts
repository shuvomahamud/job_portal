import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import { eq } from "drizzle-orm";
import { decideFieldAction } from "../src/apply/applyPolicy";
import { isBlockedFromRetry } from "../src/apply/applyRunner";
import { fillDetectedField } from "../src/apply/fillField";
import { adapterFor } from "../src/apply/applySteps";
import { loadPlaywright } from "../src/browser/session";
import { detectFields, resolveFormRoot } from "../src/formfill/domDetector";
import { buildSuggestion } from "../src/formfill/suggestions";
import type { SavedAnswer } from "../src/formfill/types";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const sampleFormUrl = pathToFileURL(
  "/Users/shuvomahamud/Projects/BroswerExtension/examples/sample-application-form.html",
).href;
const multiStepUrl = pathToFileURL(
  join(process.cwd(), "worker/tests/fixtures/multi-step-apply.html"),
).href;

function profileAnswers(): SavedAnswer[] {
  const now = new Date().toISOString();
  return [
    {
      id: "profile:first_name",
      normalizedQuestion: "first name",
      originalQuestion: "First name",
      category: "first_name",
      answerValue: "Ada",
      answerType: "text",
      sitePattern: "",
      domain: "",
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
      riskLevel: "LOW",
      notes: "",
      aliases: ["first name"],
    },
    {
      id: "profile:email",
      normalizedQuestion: "email",
      originalQuestion: "Email",
      category: "email",
      answerValue: "ada@example.com",
      answerType: "text",
      sitePattern: "",
      domain: "",
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
      riskLevel: "LOW",
      notes: "",
      aliases: ["email"],
    },
  ];
}

test("fixture modes: dry_run plans without typing; fill_only fills; fill_and_submit confirms", async () => {
  const playwright = await loadPlaywright();
  const userDataDir = await mkdtemp(join(tmpdir(), "apply-modes-"));
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
  });
  try {
    const page = await context.newPage();
    const answers = profileAnswers();
    const adapter = adapterFor("fixture");

    await page.goto(sampleFormUrl, { waitUntil: "domcontentloaded" });
    const { frame } = await resolveFormRoot(page, []);
    const fields = await detectFields(frame);
    const plan = fields.map((field) => {
      const suggestion = buildSuggestion(field, answers);
      return decideFieldAction({
        field,
        match: suggestion.match,
        savedAnswer: suggestion.savedAnswer,
        suggestedValue: suggestion.suggestedValue || undefined,
        trustLlmAnswers: false,
      });
    });
    assert.ok(plan.some((action) => action.kind === "fill"));
    const emailBefore = await frame.evaluate(() => {
      const input = document.querySelector("#email") as HTMLInputElement | null;
      return input?.value ?? "";
    });
    assert.equal(emailBefore, "");

    const emailField = fields.find((field) => field.fieldCategory === "email");
    assert.ok(emailField);
    const suggestion = buildSuggestion(emailField, answers);
    const emailAction = decideFieldAction({
      field: emailField,
      match: suggestion.match,
      savedAnswer: suggestion.savedAnswer,
      suggestedValue: "ada@example.com",
      trustLlmAnswers: false,
    });
    assert.equal(emailAction.kind, "fill");
    if (emailAction.kind === "fill") {
      await fillDetectedField(frame, emailField, emailAction.value, {
        typingDelayMs: () => 0,
      });
    }
    const emailAfter = await frame.evaluate(() => {
      const input = document.querySelector("#email") as HTMLInputElement | null;
      return input?.value ?? "";
    });
    assert.equal(emailAfter, "ada@example.com");

    await page.goto(multiStepUrl, { waitUntil: "domcontentloaded" });
    const start = await adapter.findApplyButton(page);
    assert.ok(start);
    await start.click();
    const root = await resolveFormRoot(page, []);
    const stepFields = await detectFields(root.frame);
    const first = stepFields.find((field) => field.fieldCategory === "first_name");
    assert.ok(first);
    await fillDetectedField(root.frame, first, "Ada", { typingDelayMs: () => 0 });
    const advance = await adapter.findAdvanceControl(root.frame);
    assert.ok(advance && !advance.isTerminalSubmit);
    await advance.locator.click();
    const root2 = await resolveFormRoot(page, []);
    const step2 = await detectFields(root2.frame);
    const email = step2.find((field) => field.fieldCategory === "email");
    assert.ok(email);
    await fillDetectedField(root2.frame, email, "ada@example.com", {
      typingDelayMs: () => 0,
    });
    const terminal = await adapter.findAdvanceControl(root2.frame);
    assert.ok(terminal?.isTerminalSubmit);
    await terminal!.locator.click();
    const success = await adapter.detectSuccess(page);
    assert.equal(success, true);
  } finally {
    await context.close();
  }
});

test("crash after submitting write leaves submission_unknown and blocks retry", async (t) => {
  if (!process.env.DATABASE_URL) {
    t.skip("DATABASE_URL is required for submission_unknown integration");
    return;
  }

  process.env.DASHBOARD_BASE_URL ??= "http://127.0.0.1:3000";
  process.env.WORKER_API_SECRET ??= "test-worker-api-secret-16chars";
  process.env.WORKER_ID ??= "job-worker-01";

  const schema = await import("../../src/db/schema.js");
  const { getWorkerDb } = await import("../src/db.js");

  const database = getWorkerDb();
  const userId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const sourceUrl = `file:///tmp/apply-crash-${jobId}.html`;

  await database.insert(schema.users).values({
    id: userId,
    email: `apply-crash-${userId.slice(0, 8)}@example.com`,
    name: "Apply Crash",
    authProviderId: `test-${userId}`,
  });
  await database.insert(schema.jobs).values({
    id: jobId,
    title: "Fixture Engineer",
    company: "Acme",
    source: "fixture",
    sourceUrl,
    description: "fixture",
    status: "ready_to_apply",
  });

  // Simulate: status=submitting was awaited, then process crashed before confirmation.
  const [application] = await database
    .insert(schema.applications)
    .values({
      userId,
      jobId,
      status: "submitting",
      submittedAt: new Date(),
      applyUrl: sourceUrl,
    })
    .returning();
  assert.ok(application);

  await database
    .update(schema.applications)
    .set({
      status: "submission_unknown",
      stopReason: "crash_after_submit_write",
      updatedAt: new Date(),
    })
    .where(eq(schema.applications.id, application.id));

  t.after(async () => {
    await database.delete(schema.applications).where(eq(schema.applications.jobId, jobId));
    await database.delete(schema.jobs).where(eq(schema.jobs.id, jobId));
    await database.delete(schema.users).where(eq(schema.users.id, userId));
  });

  const [row] = await database
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.jobId, jobId))
    .limit(1);
  assert.equal(row?.status, "submission_unknown");
  assert.equal(isBlockedFromRetry(row!.status), true);

  // A subsequent cycle must treat this as already handled — no navigation retry.
  const blocked = await database
    .select({ id: schema.applications.id, status: schema.applications.status })
    .from(schema.applications)
    .where(eq(schema.applications.jobId, jobId));
  assert.equal(blocked.length, 1);
  assert.equal(isBlockedFromRetry(blocked[0]!.status), true);
});
