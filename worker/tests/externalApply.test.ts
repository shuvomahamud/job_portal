import assert from "node:assert/strict";
import test from "node:test";
import { classifyPage, needsHuman, type PageSignals } from "../src/apply/external/pageClassifier";
import { decideSubmission, type SubmissionContext } from "../src/apply/external/submissionGuard";

const page = (over: Partial<PageSignals> = {}): PageSignals => ({
  url: "https://careers.acme.com/apply/123",
  text: "",
  hasPasswordField: false,
  fieldCount: 6,
  ...over,
});

test("a finished application is not mistaken for a form", () => {
  // Getting this wrong means applying to the same job twice, from the page that just
  // told us the first one worked.
  assert.equal(
    classifyPage(page({ text: "Thanks for applying! We have received your application." })),
    "confirmation",
  );
});

test("an assessment is recognised before anything is filled in", () => {
  const kind = classifyPage(page({ text: "Technical assessment — you have 60 minutes." }));
  assert.equal(kind, "assessment");
  assert.equal(needsHuman(kind), true, "no amount of form-filling gets past this");
});

test("signup and login are told apart by the password field, not the wording", () => {
  // Nearly every signup page also links to "sign in", so text alone confuses them — and
  // the difference matters: one needs a credential stored, the other needs one we have.
  assert.equal(
    classifyPage(page({
      text: "Create an account. Password. Confirm password. Already have one? Sign in",
      hasPasswordField: true,
    })),
    "signup",
  );
  assert.equal(
    classifyPage(page({
      text: "Welcome back. Sign in to continue. Forgot your password?",
      hasPasswordField: true,
    })),
    "login",
  );
});

test("an ordinary application form is a form", () => {
  assert.equal(classifyPage(page({ text: "Add your location. Zip code. City, state." })), "form");
  assert.equal(needsHuman("form"), false);
});

test("a page with nothing to fill is not guessed at", () => {
  assert.equal(classifyPage(page({ text: "About us", fieldCount: 0 })), "unknown");
});

// ---- submission guard ----

const submit = (over: Partial<SubmissionContext> = {}): SubmissionContext => ({
  mode: "fill_and_submit",
  unansweredRequiredFields: 0,
  openQuestions: 0,
  blocked: false,
  proposedByModel: true,
  looksTerminal: true,
  resumeAttached: true,
  score: 88,
  minScore: 80,
  ...over,
});

test("a complete, high-scoring application may be submitted", () => {
  assert.deepEqual(decideSubmission(submit()), { submit: true });
});

test("fill-only never submits, however good the page looks", () => {
  const decision = decideSubmission(submit({ mode: "fill_only" }));
  assert.equal(decision.submit, false);
});

test("a model proposing the button does not by itself authorise the click", () => {
  // The whole point of the split: the model may find the control, but every reason to
  // refuse is evaluated here.
  const decision = decideSubmission(submit({ proposedByModel: true, looksTerminal: false }));
  assert.equal(decision.submit, false);
});

test("nothing is submitted with required fields unanswered", () => {
  const decision = decideSubmission(submit({ unansweredRequiredFields: 2 }));
  assert.equal(decision.submit, false);
  assert.match(decision.submit ? "" : decision.reason, /2 required field/);
});

test("nothing is submitted while a question is waiting on the user", () => {
  assert.equal(decideSubmission(submit({ openQuestions: 1 })).submit, false);
});

test("nothing is submitted without the resume attached", () => {
  // Worse than not applying: it spends the opportunity on an incomplete application.
  const decision = decideSubmission(submit({ resumeAttached: false }));
  assert.equal(decision.submit, false);
  assert.match(decision.submit ? "" : decision.reason, /resume is not attached/);
});

test("the score gate is re-checked at the click, not trusted from earlier", () => {
  // Minutes of navigating an unfamiliar site separate the first check from this one, and
  // this is the last point where being wrong is still recoverable.
  assert.equal(decideSubmission(submit({ score: 79 })).submit, false);
  assert.equal(decideSubmission(submit({ score: null })).submit, false);
});

test("a challenge on the page stops the click", () => {
  assert.equal(decideSubmission(submit({ blocked: true })).submit, false);
});

// ---- control labels ----

test("a control that abandons the application is never treated as progress", async () => {
  const { classifyControlLabel } = await import("../src/apply/external/controlLocator");
  // Indeed puts "Save and close" directly above the real button on every step. It reads
  // like an advance control and throws the application away.
  assert.deepEqual(classifyControlLabel("Save and close"), {
    advances: false,
    isTerminalSubmit: false,
  });
  assert.deepEqual(classifyControlLabel("Save for later"), {
    advances: false,
    isTerminalSubmit: false,
  });
});

test("finishing is told apart from advancing", async () => {
  const { classifyControlLabel } = await import("../src/apply/external/controlLocator");
  assert.deepEqual(classifyControlLabel("Submit application"), {
    advances: true,
    isTerminalSubmit: true,
  });
  assert.deepEqual(classifyControlLabel("Continue"), {
    advances: true,
    isTerminalSubmit: false,
  });
});

test("an unrecognised label is not guessed at", async () => {
  const { classifyControlLabel } = await import("../src/apply/external/controlLocator");
  // Better to escalate to the model than to click something unknown on a real employer's
  // form.
  assert.equal(classifyControlLabel("Learn more").advances, false);
  assert.equal(classifyControlLabel("").advances, false);
});
