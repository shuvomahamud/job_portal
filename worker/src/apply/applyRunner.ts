import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import type { BrowserContextLike, FrameLike, LocatorLike, PageLike } from "../browser/playwrightTypes";
import { getConfig, sleep } from "../config";
import {
  addCommandEvent,
  getBlockedSources,
  getCandidateProfileForUser,
  getResumeVersionForUser,
  getWorkerDb,
  resolveAutomationAlerts,
} from "../db";
import {
  applyShouldHalt,
  clearInFlightApply,
  markInFlightSubmitting,
  trackInFlightApply,
} from "../workerAbort";
import { loadAnswerBankWithContext, markAnswersUsed, persistResumeLocationAnswers } from "../formfill/answerBank";
import {
  detectFields,
  expandComboboxOptions,
  resolveFormRoot,
} from "../formfill/domDetector";
import {
  buildSuggestion,
  enhanceFieldsWithOllama,
  mapDropdownWithOllama,
  retrieveAnswersWithOllamaBatch,
} from "../formfill/suggestions";
import { computedAnswerFor } from "../formfill/computedAnswers";
import { optionMatches } from "../formfill/optionMatching";
import type { DetectedField, FieldSuggestion, MatchSettings } from "../formfill/types";
import { logger } from "../logger";
import { challengeNeedsHuman, detectBrowserBlocker, siteFromUrl } from "../browser/blockerDetection";
import { reportBrowserBlocker } from "../browser/reportBlocker";
import { resolveNotifyChannel, type PendingQuestionSummary } from "../notify";
import { humanDelayMs } from "../search/browserDiscovery";
import { materializeResume } from "../resume/materialize";
import {
  locationAnswersFromResumeEntries,
  parseResumeEntries,
} from "../resume/parseEntries";
import {
  createArtifactContext,
  finishTrace,
  screenshot,
  startTrace,
  writePlanArtifact,
} from "./artifacts";
import { decideFieldAction, effectiveMode, type ApplyMode } from "./applyPolicy";
import {
  ELIGIBLE_ROLE_MATCH_STATUS,
  isApplyPaused,
  setApplyPaused,
} from "./applyEligibility";
import { waitForHumanChallenge, waitForPendingAnswers } from "./waitForHumanChallenge";
import { adapterFor, isExternalAts, looksLikeAlreadyApplied, looksLikeSubmitted, sourceUrlAllowed } from "./applySteps";
import { attachResumeFile, clearCoverLetterUploads, resumeDropzoneNeedsFile } from "./resumeUpload";
import { decideExternalSiteApply } from "./externalSitePolicy";
import {
  classifyExternalPage,
  controlIsSafeToSubmit,
  findExternalAdvanceControl,
  needsHuman,
} from "./external/externalApply";
import { decideSubmission } from "./external/submissionGuard";
import { withOllamaLock } from "../ai/ollamaLock";
import {
  fillDetectedField,
  fieldLooksAnswered,
  pendingAsksWhenFormRefused,
  type HumanTyping,
} from "./fillField";
import {
  clickResumeCardEdit,
  clickResumeCardSave,
  isHistoricalResumeLocationField,
  listIncompleteResumeCards,
  locationValueForField,
  pendingAsksFromResumeCards,
  resolveResumeCardLocation,
  syntheticLocationField,
  withResumeCardContext,
} from "./resumeCards";
import {
  createHumanTyping,
  interFieldDelayMs,
  preSubmitDelayMs,
  readingDelayMs,
} from "./humanInput";

export type ApplyStopReason =
  | "submitted"
  | "filled_not_submitted"
  | "dry_run"
  | "external_ats"
  | "needs_answers"
  | "blocked"
  | "stalled"
  | "canceled"
  | "time_limit"
  | "already_applied"
  | "needs_manual"
  | "error";

const BLOCKED_RETRY_STATUSES = [
  "draft",
  "filling",
  "awaiting_answer",
  "submitting",
  "submission_unknown",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
] as const;

export function isBlockedFromRetry(status: string): boolean {
  return (BLOCKED_RETRY_STATUSES as readonly string[]).includes(status);
}

export function statusAfterApplyFailure(
  submittingWritten: boolean,
): "submission_unknown" | "needs_manual" {
  return submittingWritten ? "submission_unknown" : "needs_manual";
}

export type ApplyJobInput = {
  commandId: string;
  userId: string;
  job: {
    id: string;
    title: string;
    company: string;
    source: string;
    sourceUrl: string;
    status: string;
    /** Drives which address on file gets filled in. */
    location?: string | null;
    remoteType?: string | null;
    /** Explicit posting pay text used by the candidate-authorized salary policy. */
    salaryText?: string | null;
    employmentType?: string | null;
    visaSignal?: string | null;
  };
  mode?: ApplyMode;
  /** A human picked this job, so the "match" scoring gate does not apply. */
  manual?: boolean;
  page: PageLike;
  browserContext: BrowserContextLike;
  /** Test hook: simulate crash after writing submitting status. */
  crashAfterSubmittingWrite?: boolean;
  random?: () => number;
  deadlineAt?: number;
};

function shortId(): string {
  return randomBytes(4).toString("hex");
}

/** Wording sites use for a step that is genuinely still working, not stuck. */
const TRANSIENT_LOAD_TEXT =
  /preparing (your )?review|please wait|processing your|submitting your|loading\b|one moment|uploading\b/i;

/**
 * True when the page looks like it is mid-transition rather than actually refusing to
 * advance.
 *
 * Found live on Indeed: a "Preparing review" screen carries no fillable fields at all, so
 * its fingerprint is identical to the previous step's — indistinguishable, by field
 * content alone, from a form that silently rejected the click. The stall check fires on
 * the very first repeat, so without this a transient loading screen was condemned before
 * it had a chance to finish loading.
 */
export async function looksLikeTransientLoad(frame: FrameLike): Promise<boolean> {
  const spinner = frame.locator(
    '[class*="spinner" i], [class*="loading" i][aria-hidden="false"]',
  );
  if ((await spinner.count().catch(() => 0)) > 0) {
    if (await spinner.first().isVisible({ timeout: 500 }).catch(() => false)) return true;
  }

  // Indeed keeps a determinate application progress bar on every Easy Apply step
  // (the live miss was a persistent 38% bar). That is page chrome, not a load overlay.
  // An indeterminate progressbar — no aria-valuenow — is still treated as loading.
  const bars = frame.locator('[role="progressbar"]');
  const barCount = await bars.count().catch(() => 0);
  for (let index = 0; index < barCount; index += 1) {
    const bar = bars.nth(index);
    if (!(await bar.isVisible({ timeout: 500 }).catch(() => false))) continue;
    if (await isDeterminateProgress(bar)) continue;
    return true;
  }

  const loadText = frame.getByText(TRANSIENT_LOAD_TEXT);
  if ((await loadText.count().catch(() => 0)) > 0) {
    return loadText.first().isVisible({ timeout: 500 }).catch(() => false);
  }
  return false;
}

async function isDeterminateProgress(bar: LocatorLike): Promise<boolean> {
  const now = await bar.getAttribute("aria-valuenow").catch(() => null);
  if (now == null || now.trim() === "") return false;
  const value = Number(now);
  return Number.isFinite(value);
}

export const TRANSIENT_LOAD_BUDGET_MS = 8_000;
export const TRANSIENT_LOAD_POLL_MS = 1_500;

/**
 * Waits out a loading screen on a clock, not by burning logical form steps.
 *
 * Indeed's "Preparing review" overlay used to `continue` the apply loop four times at
 * 1.5s each, which consumed four of the default eight `JOB_APPLY_MAX_STEPS`. A review
 * page that finished loading on the last poll then had no steps left to process it.
 */
export async function waitOutTransientLoad(
  frame: FrameLike,
  options?: {
    budgetMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    shouldHalt?: () => Promise<boolean>;
  },
): Promise<"cleared" | "timeout" | "aborted"> {
  const budgetMs = options?.budgetMs ?? TRANSIENT_LOAD_BUDGET_MS;
  const pollMs = options?.pollMs ?? TRANSIENT_LOAD_POLL_MS;
  const sleepFn = options?.sleep ?? sleep;
  const deadline = Date.now() + budgetMs;
  while (await looksLikeTransientLoad(frame)) {
    if (options?.shouldHalt && (await options.shouldHalt())) return "aborted";
    if (Date.now() >= deadline) return "timeout";
    await sleepFn(pollMs);
  }
  return "cleared";
}

/**
 * After a loading overlay clears, the review page often still has no fillable fields and
 * the same URL as the spinner — so the field fingerprint does not change. Submit is a
 * button, not a field, and is not in that fingerprint. A successful wait must not be
 * treated as "the form refused to advance."
 */
export function shouldTreatPageAsUnchangedStall(input: {
  clickedWithoutProgress: boolean;
  fingerprint: string;
  previousFingerprint: string;
  justClearedTransientLoad: boolean;
}): boolean {
  if (input.justClearedTransientLoad) return false;
  return input.clickedWithoutProgress && input.fingerprint === input.previousFingerprint;
}

export type IdentityCheck =
  | { verified: true; corrected: boolean }
  | { verified: false; reason: string };

function collapseWs(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function contactNameMatchesExpected(
  contactName: string,
  first: string | null,
  last: string | null,
): boolean {
  const got = collapseWs(contactName).toLowerCase();
  const expected = collapseWs([first, last].filter(Boolean).join(" ")).toLowerCase();
  return Boolean(expected) && got === expected;
}

/**
 * Reads the dedicated Name / Contact information value on a review page.
 *
 * Whole-page text search is not safe: the resume filename often contains the legal name
 * while the contact row still shows an account nickname. Hidden nodes are excluded
 * because this walks getComputedStyle / bounding boxes.
 */
const READ_REVIEW_CONTACT_NAME_SCRIPT = `(() => {
  const LABEL = /^(name|full name|legal name|contact name|contact information|applicant name|your name)$/i;
  function visible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }
  function ownDirectText(el) {
    return Array.from(el.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => (node.textContent || "").replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
  }
  function firstLine(value) {
    return value.split("\\n").map((line) => line.trim()).filter(Boolean)[0] || "";
  }
  function plausibleName(value) {
    const text = firstLine(value).replace(/\\s+/g, " ").trim();
    if (!text || text.length > 80) return "";
    if (/\\.pdf\\b|resume|curriculum|\\bcv\\b/i.test(text)) return "";
    if (text.includes("@")) return "";
    return text;
  }
  const hits = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const leaf = ownDirectText(el) || (el.childElementCount === 0 ? (el.textContent || "").trim() : "");
    const collapsed = leaf.replace(/\\s+/g, " ").trim();
    if (!LABEL.test(collapsed)) continue;
    let value = "";
    if (el.nextElementSibling && visible(el.nextElementSibling)) {
      value = plausibleName(el.nextElementSibling.innerText || "");
    }
    if (!value && el.parentElement && visible(el.parentElement)) {
      const parentText = (el.parentElement.innerText || "").replace(/\\s+/g, " ").trim();
      if (parentText.toLowerCase().startsWith(collapsed.toLowerCase())) {
        value = plausibleName(parentText.slice(collapsed.length));
      }
    }
    if (value) hits.push(value);
  }
  return hits[0] || null;
})()`;

export async function readReviewContactName(frame: FrameLike): Promise<string | null> {
  const value = await frame.evaluate(READ_REVIEW_CONTACT_NAME_SCRIPT).catch(() => null);
  if (typeof value !== "string") return null;
  const trimmed = collapseWs(value);
  return trimmed || null;
}

async function readFieldValue(frame: FrameLike, field: DetectedField): Promise<string | null> {
  const live = await frame
    .locator(field.selector)
    .first()
    .inputValue({ timeout: 1000 })
    .catch(() => null);
  return live;
}

async function confirmNameField(
  frame: FrameLike,
  field: DetectedField,
  expected: string,
  human: HumanTyping,
  label: string,
): Promise<{ ok: boolean; corrected: boolean; reason?: string }> {
  const live = await readFieldValue(frame, field);
  const before = collapseWs(live && live.trim() ? live : field.currentValue);
  if (before === expected) return { ok: true, corrected: false };
  await fillDetectedField(frame, field, expected, human);
  const after = collapseWs((await readFieldValue(frame, field)) ?? "");
  if (after !== expected) {
    return {
      ok: false,
      corrected: true,
      reason: `Could not confirm ${label} after correcting the field.`,
    };
  }
  return { ok: true, corrected: true };
}

/**
 * Confirms the name about to be submitted is actually the candidate's, and fixes it when
 * it is not and can be.
 *
 * Found live: an Indeed application resumed past the contact-info step — the site
 * remembers progress across a retry — so the run never revisited the page holding the
 * name fields, and a stale value from the Indeed account's own profile went out
 * unexamined. The existing fill-time fix (clear before typing) only ever helps on a run
 * that actually reaches that page.
 *
 * Expected names come from the candidate profile, not the answer bank: job/company
 * answers precede profile answers, so a stale learned name must not become the
 * "correct" name. Every configured component (first, last, or both) must be confirmed
 * via a visible field readback. When a component has no field — typical on a review
 * page — confirmation must come from a dedicated Name / Contact information row, not
 * from searching the whole page (a resume filename is not a contact name).
 */
export function wizardStepIsIncomplete(text: string): boolean {
  const match = text.match(/\bstep\s+(\d+)\s+of\s+(\d+)\b/i);
  if (!match) return false;
  return Number(match[1]) < Number(match[2]);
}

/** Dice's review step has no Name/Contact row; identity lives on the logged-in account. */
export function boardHostedAccountIdentity(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "dice.com" || host.endsWith(".dice.com");
  } catch {
    return false;
  }
}

export async function verifyIdentityBeforeSubmit(
  frame: FrameLike,
  fields: DetectedField[],
  human: HumanTyping,
  expectedFirstName: string | null,
  expectedLastName: string | null,
  alreadyConfirmedThisRun = false,
): Promise<IdentityCheck> {
  const first = expectedFirstName?.trim() || null;
  const last = expectedLastName?.trim() || null;
  if (!first && !last) {
    // No profile name on file at all is a data problem for the profile page, not
    // something this run can resolve mid-application.
    return { verified: false, reason: "No first or last name is on file to verify against." };
  }

  const firstField = fields.find((f) => f.fieldCategory === "first_name");
  const lastField = fields.find((f) => f.fieldCategory === "last_name");
  let corrected = false;

  if (first && firstField) {
    const result = await confirmNameField(frame, firstField, first, human, "first name");
    if (!result.ok) return { verified: false, reason: result.reason! };
    corrected = corrected || result.corrected;
  }
  if (last && lastField) {
    const result = await confirmNameField(frame, lastField, last, human, "last name");
    if (!result.ok) return { verified: false, reason: result.reason! };
    corrected = corrected || result.corrected;
  }

  const missingStructuredComponent = Boolean((first && !firstField) || (last && !lastField));
  if (missingStructuredComponent && alreadyConfirmedThisRun) {
    return { verified: true, corrected };
  }
  if (missingStructuredComponent) {
    const structured = await readReviewContactName(frame);
    if (structured) {
      if (!contactNameMatchesExpected(structured, first, last)) {
        return {
          verified: false,
          reason: `Contact name "${structured}" does not match the candidate profile.`,
        };
      }
    } else if (boardHostedAccountIdentity(frame.url())) {
      // Dice Easy Apply never shows a Name row; the logged-in Dice profile is what
      // the employer receives. Refusing here blocked every Dice submit after a
      // complete review page.
      return { verified: true, corrected };
    } else {
      return {
        verified: false,
        reason: "Could not find a Name / Contact information row to confirm before submitting.",
      };
    }
  }

  return { verified: true, corrected };
}

function fieldFingerprint(fields: DetectedField[], frameUrl: string): string {
  return `${fields
    .map((field) => field.id)
    .sort()
    .join("|")}|${frameUrl}`;
}

async function upsertApplication(input: {
  userId: string;
  jobId: string;
  status: string;
  targetRoleId?: string | null;
  jobRoleMatchId?: string | null;
  resumeVersionId?: string | null;
  applyUrl?: string | null;
  stopReason?: string | null;
  submittedAt?: Date | null;
  appliedAt?: Date | null;
  confirmationEvidence?: Record<string, unknown> | null;
  notes?: string | null;
}) {
  const database = getWorkerDb();
  const now = new Date();
  const [row] = await database
    .insert(schema.applications)
    .values({
      userId: input.userId,
      jobId: input.jobId,
      status: input.status as typeof schema.applications.$inferInsert.status,
      targetRoleId: input.targetRoleId ?? null,
      jobRoleMatchId: input.jobRoleMatchId ?? null,
      resumeVersionId: input.resumeVersionId ?? null,
      applyUrl: input.applyUrl ?? null,
      stopReason: input.stopReason ?? null,
      submittedAt: input.submittedAt ?? null,
      appliedAt: input.appliedAt ?? null,
      confirmationEvidence: input.confirmationEvidence ?? {},
      applicationNotes: input.notes ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.applications.jobId, schema.applications.userId],
      set: {
        status: input.status as typeof schema.applications.$inferInsert.status,
        targetRoleId: input.targetRoleId ?? undefined,
        jobRoleMatchId: input.jobRoleMatchId ?? undefined,
        resumeVersionId: input.resumeVersionId ?? undefined,
        applyUrl: input.applyUrl ?? undefined,
        stopReason: input.stopReason ?? undefined,
        submittedAt: input.submittedAt ?? undefined,
        appliedAt: input.appliedAt ?? undefined,
        confirmationEvidence: input.confirmationEvidence ?? undefined,
        applicationNotes: input.notes ?? undefined,
        updatedAt: now,
      },
    })
    .returning();
  return row!;
}

async function claimApplication(input: {
  commandId: string;
  userId: string;
  jobId: string;
  targetRoleId: string;
  /** Null when a human applied to a job that was never scored against a role. */
  jobRoleMatchId: string | null;
  resumeVersionId: string;
  applyUrl: string;
}) {
  const now = new Date();
  const [row] = await getWorkerDb()
    .insert(schema.applications)
    .values({
      userId: input.userId,
      jobId: input.jobId,
      targetRoleId: input.targetRoleId,
      jobRoleMatchId: input.jobRoleMatchId,
      resumeVersionId: input.resumeVersionId,
      applyUrl: input.applyUrl,
      workerCommandId: input.commandId,
      status: "draft",
      stopReason: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.applications.jobId, schema.applications.userId],
      set: {
        status: "draft",
        targetRoleId: input.targetRoleId,
        jobRoleMatchId: input.jobRoleMatchId,
        resumeVersionId: input.resumeVersionId,
        applyUrl: input.applyUrl,
        stopReason: null,
        workerCommandId: input.commandId,
        updatedAt: now,
      },
      setWhere: or(
        inArray(schema.applications.status, [
          "ready",
          "needs_manual",
          "blocked",
          "failed",
        ]),
        eq(schema.applications.workerCommandId, input.commandId),
      ),
    })
    .returning();
  return row ?? null;
}

export async function applyToJob(input: ApplyJobInput): Promise<{
  stopReason: ApplyStopReason;
  applicationId?: string;
  artifacts: string[];
}> {
  const cfg = getConfig();
  const random = input.random ?? Math.random;
  const mode = effectiveMode(input.mode, cfg.JOB_APPLY_MODE);
  const artifacts: string[] = [];
  const matchSettings: MatchSettings = {
    ollamaBaseUrl: cfg.OLLAMA_BASE_URL,
    ollamaAllowedRemoteHosts: cfg.ollamaAllowedRemoteHosts,
    ollamaRequestTimeoutMs: cfg.OLLAMA_REQUEST_TIMEOUT_MS,
    ollamaKeepAlive: cfg.OLLAMA_KEEP_ALIVE,
    selectedModel: cfg.OLLAMA_MODEL,
    autoFillConfidenceThreshold: 0.9,
    allowAutoFillLowRisk: true,
    requireReviewMediumHigh: true,
    useOllamaForAmbiguous: true,
    allowOneClickSavedGender: false,
    allowOneClickSavedWorkEligibility: false,
  };

  if (!cfg.JOB_APPLY_ENABLED && !input.job.sourceUrl.startsWith("file:")) {
    throw new Error("Job apply is disabled. Set JOB_APPLY_ENABLED=true only on the Mac worker.");
  }

  if (!["indeed", "dice", "fixture"].includes(input.job.source)) {
    return { stopReason: "needs_manual", artifacts };
  }
  if (!sourceUrlAllowed(input.job.source, input.job.sourceUrl)) {
    return { stopReason: "needs_manual", artifacts };
  }

  const database = getWorkerDb();
  if (await isApplyPaused(input.userId)) {
    return { stopReason: "needs_manual", artifacts };
  }
  const blocking = await database
    .select({
      id: schema.applications.id,
      status: schema.applications.status,
      workerCommandId: schema.applications.workerCommandId,
    })
    .from(schema.applications)
    .where(
      and(
        eq(schema.applications.jobId, input.job.id),
        eq(schema.applications.userId, input.userId),
        inArray(schema.applications.status, [...BLOCKED_RETRY_STATUSES]),
      ),
    )
    .limit(1);
  if (blocking[0]) {
    if (blocking[0].status === "submitting") {
      await database
        .update(schema.applications)
        .set({
          status: "submission_unknown",
          stopReason: "recovered_stale_submitting_state",
          updatedAt: new Date(),
        })
        .where(eq(schema.applications.id, blocking[0].id));
      return {
        stopReason: "already_applied",
        applicationId: blocking[0].id,
        artifacts,
      };
    }
    const recoverableSameCommand =
      blocking[0].workerCommandId === input.commandId &&
      ["draft", "filling"].includes(blocking[0].status);
    if (!recoverableSameCommand) {
      return {
        stopReason: "already_applied",
        applicationId: blocking[0].id,
        artifacts,
      };
    }
  }

  // No active role means nothing gets submitted. The active role is what selects the
  // resume, so without one there is no defensible answer to "which resume did you send".
  // Checked explicitly rather than inferred from an empty join, so the stop reason
  // distinguishes "no role configured" from "this job did not match".
  const [activeRole] = await database
    .select({ id: schema.targetRoles.id })
    .from(schema.targetRoles)
    .where(
      and(
        eq(schema.targetRoles.userId, input.userId),
        eq(schema.targetRoles.active, true),
      ),
    )
    .limit(1);
  if (!activeRole) {
    await upsertApplication({
      userId: input.userId,
      jobId: input.job.id,
      status: "needs_manual",
      stopReason: "No active target role, so nothing was submitted.",
    });
    return { stopReason: "needs_manual", artifacts };
  }

  // The automated cycle applies only to jobs scored "match". A person choosing a job from
  // the board has already made that call, so the scoring gate is skipped for them; the
  // active role, its resume, the daily caps and the pause switch all still apply.
  const matchConditions = [
    eq(schema.jobRoleMatches.jobId, input.job.id),
    eq(schema.jobRoleMatches.userId, input.userId),
    eq(schema.targetRoles.active, true),
    ...(input.manual
      ? []
      : [eq(schema.jobRoleMatches.status, ELIGIBLE_ROLE_MATCH_STATUS)]),
  ];

  const [match] = await database
    .select({
      id: schema.jobRoleMatches.id,
      targetRoleId: schema.jobRoleMatches.targetRoleId,
      resumeVersionId: schema.jobRoleMatches.resumeVersionId,
      score: schema.jobRoleMatches.score,
      status: schema.jobRoleMatches.status,
    })
    .from(schema.jobRoleMatches)
    .innerJoin(schema.targetRoles, eq(schema.targetRoles.id, schema.jobRoleMatches.targetRoleId))
    .where(and(...matchConditions))
    .orderBy(desc(schema.jobRoleMatches.score))
    .limit(1);

  // A manually chosen job may never have been scored against a role at all. Fall back to
  // the active role's own resume so an explicit request is not refused for lack of a row.
  let selected: {
    id: string | null;
    targetRoleId: string;
    resumeVersionId: string;
  } | null = match?.resumeVersionId
    ? {
        id: match.id,
        targetRoleId: match.targetRoleId,
        resumeVersionId: match.resumeVersionId,
      }
    : null;

  if (!selected && input.manual) {
    const [role] = await database
      .select({
        id: schema.targetRoles.id,
        resumeVersionId: schema.targetRoles.resumeVersionId,
      })
      .from(schema.targetRoles)
      .where(
        and(
          eq(schema.targetRoles.userId, input.userId),
          eq(schema.targetRoles.active, true),
        ),
      )
      .limit(1);
    if (role) {
      selected = { id: null, targetRoleId: role.id, resumeVersionId: role.resumeVersionId };
    }
  }

  if (!selected) {
    await upsertApplication({
      userId: input.userId,
      jobId: input.job.id,
      status: "needs_manual",
      stopReason: input.manual
        ? "The active role has no resume to apply with."
        : "The active role has no eligible match with a resume for this job.",
    });
    return { stopReason: "needs_manual", artifacts };
  }

  let resumePath: string | null = null;
  // Set once the upload genuinely succeeds, and never attempted again after that. Dice
  // rerenders its page once a resume is attached — the widget replaces itself with a
  // preview — and the field detector then reports a second file input at a fresh
  // positional selector. Re-running setInputFiles against it waits for an element that is
  // never going to become attached and enabled, and times out at 30s, which used to take
  // the whole application down with it: no try/catch wrapped the call, so the failure
  // propagated out of the step loop entirely.
  let resumeUploaded = false;
  /** Distinguishes "no resume field on this form" from "the field is there and empty". */
  let sawResumeUploadField = false;
  const resumeVersionId = selected.resumeVersionId;
  if (resumeVersionId) {
    try {
      const material = await materializeResume(resumeVersionId);
      resumePath = material.absolutePath;
    } catch (error) {
      await upsertApplication({
        userId: input.userId,
        jobId: input.job.id,
        status: "needs_manual",
        targetRoleId: selected.targetRoleId,
        jobRoleMatchId: selected.id,
        resumeVersionId,
        stopReason: error instanceof Error ? error.message : "Resume materialize failed",
      });
      return { stopReason: "needs_manual", artifacts };
    }
  }

  const application = await claimApplication({
    commandId: input.commandId,
    userId: input.userId,
    jobId: input.job.id,
    targetRoleId: selected.targetRoleId,
    jobRoleMatchId: selected.id,
    resumeVersionId,
    applyUrl: input.job.sourceUrl,
  });
  if (!application) {
    return { stopReason: "already_applied", artifacts };
  }

  const adapter = adapterFor(input.job.source);
  const artifactCtx = await createArtifactContext({
    commandId: input.commandId,
    jobId: input.job.id,
    artifactDir: cfg.JOB_APPLY_ARTIFACT_DIR,
    page: input.page,
    context: input.browserContext,
  });
  await startTrace(artifactCtx);
  let submittingWritten = false;
  trackInFlightApply({
    commandId: input.commandId,
    userId: input.userId,
    jobId: input.job.id,
  });

  try {
    const persistHalt = async (stopReason: string) => {
      await upsertApplication({
        userId: input.userId,
        jobId: input.job.id,
        status: statusAfterApplyFailure(submittingWritten),
        stopReason: submittingWritten ? "submit_aborted_before_click" : stopReason,
      });
      await finishTrace(artifactCtx, true);
    };

    const handlePageBlocker = async (
      page: PageLike,
      blocker: {
        kind: "captcha" | "login_required" | "access_denied";
        site: ReturnType<typeof siteFromUrl>;
        pageUrl: string;
        message: string;
        evidence: string;
      },
      screenshotName: string,
    ): Promise<"continue" | "blocked" | "canceled" | "time_limit"> => {
      if (!challengeNeedsHuman(blocker.kind)) {
        await reportBrowserBlocker({
          commandId: input.commandId,
          userId: input.userId,
          blocker,
          cfg,
        });
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "blocked",
          stopReason: blocker.message,
          applyUrl: page.url(),
        });
        await screenshot(artifactCtx, screenshotName);
        await finishTrace(artifactCtx, true);
        return "blocked";
      }

      await screenshot(artifactCtx, screenshotName);
      await upsertApplication({
        userId: input.userId,
        jobId: input.job.id,
        status: submittingWritten ? "submitting" : "filling",
        stopReason: "waiting_for_human",
        applyUrl: page.url(),
      });
      logger.info("Apply paused for a human challenge", {
        commandId: input.commandId,
        jobId: input.job.id,
        kind: blocker.kind,
        site: blocker.site,
        pageUrl: page.url(),
      });

      const wait = await waitForHumanChallenge({
        initial: blocker,
        detect: () => detectBrowserBlocker(page, siteFromUrl(page.url())),
        isPaused: () => isApplyPaused(input.userId),
        setPaused: (paused) => setApplyPaused(input.userId, paused),
        alertStillOpen: async () => (await getBlockedSources(input.userId)).includes(blocker.site),
        onAsk: async (current) => {
          await reportBrowserBlocker({
            commandId: input.commandId,
            userId: input.userId,
            blocker: current,
            cfg,
          });
          await addCommandEvent(
            input.commandId,
            "apply_waiting_for_human",
            current.message,
            {
              jobId: input.job.id,
              kind: current.kind,
              site: current.site,
              pageUrl: current.pageUrl,
            },
          );
        },
        onCleared: async () => {
          await resolveAutomationAlerts(input.userId, [blocker.site]);
          await addCommandEvent(
            input.commandId,
            "apply_human_challenge_cleared",
            "Human challenge cleared; apply continuing.",
            { jobId: input.job.id, site: blocker.site },
          );
        },
        shouldHalt: async () =>
          (await applyShouldHalt(input.commandId)) ||
          Boolean(input.deadlineAt && Date.now() >= input.deadlineAt),
      });

      if (wait === "aborted") {
        if (input.deadlineAt && Date.now() >= input.deadlineAt) return "time_limit";
        return "canceled";
      }
      return "continue";
    };

    if (await applyShouldHalt(input.commandId)) {
      await upsertApplication({
        userId: input.userId,
        jobId: input.job.id,
        status: "needs_manual",
        stopReason: "canceled",
      });
      return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
    }

    await input.page.goto(input.job.sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: cfg.JOB_BROWSER_NAVIGATION_TIMEOUT_MS,
    });
    const fixture = input.job.sourceUrl.startsWith("file:");
    const resolvePauseOrChallenge = async (
      page: PageLike,
      screenshotName: string,
    ): Promise<"continue" | "paused" | "blocked" | "canceled" | "time_limit" | "already_applied"> => {
      // Captcha on Indeed's last review page appears *after* the step starts — often
      // after "Preparing review" clears. Checking only when the user already paused
      // meant the worker kept clicking Continue through an image grid until max_steps.
      if (!fixture) {
        const blocker = await detectBrowserBlocker(page, siteFromUrl(page.url()));
        if (blocker) {
          return handlePageBlocker(page, blocker, screenshotName);
        }
      }
      const held = await holdIfUserPaused(page);
      if (held === "continue") return "continue";
      return held;
    };
    const stopFromChallenge = async (
      outcome: "continue" | "paused" | "blocked" | "canceled" | "time_limit" | "already_applied",
      pausedReason: string,
    ) => {
      if (outcome === "continue") return null;
      if (outcome === "already_applied") {
        return { stopReason: "already_applied" as const, applicationId: application.id, artifacts: artifactCtx.paths };
      }
      if (outcome === "blocked") {
        return { stopReason: "blocked" as const, applicationId: application.id, artifacts: artifactCtx.paths };
      }
      if (outcome === "paused") {
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "needs_manual",
          stopReason: pausedReason,
        });
        await finishTrace(artifactCtx, true);
        return { stopReason: "canceled" as const, applicationId: application.id, artifacts: artifactCtx.paths };
      }
      await persistHalt(outcome === "time_limit" ? "application_time_limit" : "canceled");
      return {
        stopReason: (outcome === "time_limit" ? "time_limit" : "canceled") as "time_limit" | "canceled",
        applicationId: application.id,
        artifacts: artifactCtx.paths,
      };
    };
    await sleep(
      fixture
        ? 50
        : humanDelayMs(
            {
              minDelayMs: Math.min(cfg.JOB_BROWSER_MIN_DELAY_MS, 2500),
              maxDelayMs: Math.min(cfg.JOB_BROWSER_MAX_DELAY_MS, 5000),
            },
            random,
          ),
    );
    const bodyText = await input.page.locator("body").innerText().catch(() => "");
    await sleep(fixture ? 20 : readingDelayMs(bodyText.split(/\s+/).filter(Boolean).length, random));
    await screenshot(artifactCtx, "00-jobpage");

    const detectedBlocker = fixture
      ? null
      : await detectBrowserBlocker(input.page, siteFromUrl(input.page.url()));
    const legacyBlocked = detectedBlocker ? null : await adapter.detectBlocked(input.page);
    if (detectedBlocker || legacyBlocked?.blocked) {
      const blocker = detectedBlocker ?? {
        kind: "captcha" as const,
        site: siteFromUrl(input.page.url()),
        pageUrl: input.page.url(),
        message: legacyBlocked!.reason,
        evidence: legacyBlocked!.reason,
      };
      const outcome = await handlePageBlocker(input.page, blocker, "blocked");
      if (outcome === "blocked") {
        return { stopReason: "blocked", applicationId: application.id, artifacts: artifactCtx.paths };
      }
      if (outcome === "canceled") {
        await persistHalt("canceled");
        return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
      }
      if (outcome === "time_limit") {
        await persistHalt("application_time_limit");
        return { stopReason: "time_limit", applicationId: application.id, artifacts: artifactCtx.paths };
      }
    }

    const persistAlreadyApplied = async (page: PageLike, evidence: Record<string, unknown>) => {
      await upsertApplication({
        userId: input.userId,
        jobId: input.job.id,
        status: "applied",
        applyUrl: page.url(),
        submittedAt: new Date(),
        appliedAt: new Date(),
        confirmationEvidence: evidence,
        stopReason: "already_applied",
      });
      await screenshot(artifactCtx, "already-applied");
      await finishTrace(artifactCtx, false);
    };

    const pageLooksFinished = async (page: PageLike) => {
      const text = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      return looksLikeAlreadyApplied(text) || looksLikeSubmitted(text);
    };

    const holdIfUserPaused = async (
      page: PageLike,
    ): Promise<"continue" | "canceled" | "time_limit" | "already_applied"> => {
      if (!(await isApplyPaused(input.userId))) return "continue";
      logger.info("Apply paused; Chrome is yours until Resume", {
        commandId: input.commandId,
        jobId: input.job.id,
        pageUrl: page.url(),
      });
      await upsertApplication({
        userId: input.userId,
        jobId: input.job.id,
        status: "filling",
        stopReason: "user_paused",
        applyUrl: page.url(),
      });
      const wait = await waitForPendingAnswers({
        isPaused: () => isApplyPaused(input.userId),
        setPaused: (paused) => setApplyPaused(input.userId, paused),
        shouldHalt: async () =>
          (await applyShouldHalt(input.commandId)) ||
          Boolean(input.deadlineAt && Date.now() >= input.deadlineAt),
      });
      if (wait === "aborted") {
        if (input.deadlineAt && Date.now() >= input.deadlineAt) return "time_limit";
        return "canceled";
      }
      if (await pageLooksFinished(page)) {
        await persistAlreadyApplied(page, { humanCompleted: true, pageUrl: page.url() });
        return "already_applied";
      }
      return "continue";
    };

    const applyButton = await adapter.findApplyButton(input.page);
    if (applyButton) {
      await applyButton.click({ timeout: 5000 });
      await sleep(800 + random() * 700);
    }

    const pages = input.browserContext.pages();
    const activePage = pages[pages.length - 1] ?? input.page;
    artifactCtx.page = activePage;
    const applyUrl = activePage.url();
    // Dice's confirmation page often replaces Easy Apply after the click, not in the
    // same paint. A single 800ms glance still sees the job post and later stalls on
    // "You've already applied to this job!".
    const alreadyAppliedDeadline = Date.now() + (fixture ? 50 : 6_000);
    while (Date.now() < alreadyAppliedDeadline) {
      if (await pageLooksFinished(activePage)) {
        await persistAlreadyApplied(activePage, { alreadyAppliedPage: true });
        return { stopReason: "already_applied", applicationId: application.id, artifacts: artifactCtx.paths };
      }
      if (fixture) break;
      await sleep(400);
    }
    const external = isExternalAts(applyUrl, adapter.allowedApplyHosts);
    let onExternalSite = false;
    if (external.external && input.job.source !== "fixture") {
      const decision = decideExternalSiteApply({
        host: external.host,
        enabled: cfg.JOB_APPLY_EXTERNAL_SITES_ENABLED,
        minScore: cfg.JOB_APPLY_EXTERNAL_MIN_SCORE,
        score: match?.score ?? null,
        status: match?.status ?? null,
      });
      if (!decision.allowed) {
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "needs_manual",
          stopReason: decision.reason,
          applyUrl,
        });
        await finishTrace(artifactCtx, true);
        return { stopReason: "external_ats", applicationId: application.id, artifacts: artifactCtx.paths };
      }
      // Past here the run is on an employer's own site. The field detector, answer bank
      // and risk policy are all site-agnostic already, so filling proceeds unchanged; what
      // differs is that nothing about this page has been rehearsed.
      onExternalSite = true;
      await addCommandEvent(
        input.commandId,
        "external_site_apply_started",
        `Following the posting to ${external.host} to apply on the employer's own site.`,
        { jobId: input.job.id, host: external.host, applyUrl, score: match?.score ?? null },
      );

      // An employer's site can hand back anything. The board flow may assume it is looking
      // at an application form; here that assumption is how an agent ends up typing a home
      // address into a password field.
      const kind = await classifyExternalPage(activePage, 0);
      if (needsHuman(kind)) {
        const reason = kind === "assessment"
          ? `${external.host} requires an assessment, which needs you.`
          : `${external.host} requires an account (${kind}), which needs you.`;
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "needs_manual",
          stopReason: reason,
          applyUrl,
        });
        await addCommandEvent(
          input.commandId,
          "external_site_needs_human",
          reason,
          { jobId: input.job.id, host: external.host, pageKind: kind, applyUrl },
        );
        await finishTrace(artifactCtx, true);
        return { stopReason: "needs_manual", applicationId: application.id, artifacts: artifactCtx.paths };
      }
    }

    await upsertApplication({
      userId: input.userId,
      jobId: input.job.id,
      status: "filling",
      applyUrl,
      targetRoleId: match?.targetRoleId,
      jobRoleMatchId: match?.id,
      resumeVersionId,
    });

    const bank = await loadAnswerBankWithContext({
      userId: input.userId,
      jobId: input.job.id,
      company: input.job.company,
      domain: (() => {
        try {
          return new URL(input.job.sourceUrl).hostname;
        } catch {
          return "";
        }
      })(),
      jobLocation: input.job.location,
      remoteType: input.job.remoteType,
      salaryText: input.job.salaryText,
      jobTitle: input.job.title,
      employmentType: input.job.employmentType,
      visaSignal: input.job.visaSignal,
    });
    const answers = bank.answers;
    const resumeRecord = resumeVersionId
      ? await getResumeVersionForUser(resumeVersionId, input.userId)
      : null;
    const resumeEntries = parseResumeEntries(resumeRecord?.resumeText ?? "");
    const parsedLocations = locationAnswersFromResumeEntries(resumeEntries);
    if (parsedLocations.length) {
      await persistResumeLocationAnswers(input.userId, parsedLocations);
      const seen = new Set(answers.map((answer) => `${answer.normalizedQuestion}|${answer.category}`));
      for (const parsed of parsedLocations) {
        const key = `${parsed.normalizedQuestion}|${parsed.category}`;
        if (seen.has(key)) continue;
        seen.add(key);
        answers.push(parsed);
      }
    }
    // Authoritative name for the pre-submit identity gate. The answer bank is ordered
    // job → company → profile, so a stale learned first_name would otherwise beat the
    // candidate profile. This check is about who is being submitted, not what a prior
    // form once accepted.
    const profile = await getCandidateProfileForUser(input.userId);
    const expectedFirstName = profile?.firstName?.trim() || null;
    const expectedLastName = profile?.lastName?.trim() || null;
    let identityConfirmedThisRun = false;
    if (bank.addressLabel) {
      // Logged as well as recorded: command events only reach the dashboard, while the
      // JobAgent activity log mirrors this process's stdout. Both decisions below put
      // real data into a real application, so they should be visible as a run happens.
      logger.info(`Applying with the "${bank.addressLabel}" address`, {
        jobId: input.job.id,
        jobLocation: input.job.location ?? null,
        reason: bank.addressReason ?? undefined,
      });
      await addCommandEvent(
        input.commandId,
        "apply_address_selected",
        `Applying with the "${bank.addressLabel}" address. ${bank.addressReason ?? ""}`.trim(),
        {
          jobId: input.job.id,
          addressLabel: bank.addressLabel,
          jobLocation: input.job.location ?? null,
        },
      );
    }
    if (bank.salaryDecision) {
      logger.info(
        `Answering compensation with ${bank.salaryDecision.target} (${bank.salaryDecision.period})`,
        {
          jobId: input.job.id,
          postedRange: input.job.salaryText ?? null,
          reason: bank.salaryDecision.reason,
        },
      );
      await addCommandEvent(
        input.commandId,
        "apply_salary_derived",
        `Derived a ${bank.salaryDecision.period} compensation answer from the posting's explicit pay range.`,
        {
          jobId: input.job.id,
          salaryText: input.job.salaryText ?? null,
          target: bank.salaryDecision.target,
          minimum: bank.salaryDecision.minimum,
          maximum: bank.salaryDecision.maximum,
          reason: bank.salaryDecision.reason,
        },
      );
    }
    if (bank.authorizationDecision) {
      await addCommandEvent(
        input.commandId,
        "apply_authorization_policy_selected",
        `Selected sponsorship=${bank.authorizationDecision.sponsorshipRequired} for this ${bank.authorizationDecision.isContractRole ? "contractor" : "direct-employment"} role.`,
        {
          jobId: input.job.id,
          isContractRole: bank.authorizationDecision.isContractRole,
          workAuthorization: bank.authorizationDecision.workAuthorization,
          sponsorshipRequired: bank.authorizationDecision.sponsorshipRequired,
          reason: bank.authorizationDecision.reason,
        },
      );
    }

    const human = createHumanTyping(random);
    const plan: Array<Record<string, unknown>> = [];
    let previousFingerprint = "";
    let stallRetries = 0;
    /** Set after clicking to advance, so an unchanged page next round means the form refused. */
    let clickedWithoutProgress = false;
    let waitedForAnswers = false;
    let resumeAdvance = false;

    for (let step = 0; step < cfg.JOB_APPLY_MAX_STEPS; step += 1) {
      const pauseOrChallenge = await resolvePauseOrChallenge(activePage, `blocked-step-${step}`);
      const stopped = await stopFromChallenge(pauseOrChallenge, "apply_paused");
      if (stopped) return stopped;
      if (input.deadlineAt && Date.now() >= input.deadlineAt) {
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "needs_manual",
          stopReason: "application_time_limit",
        });
        await finishTrace(artifactCtx, true);
        return { stopReason: "time_limit", applicationId: application.id, artifacts: artifactCtx.paths };
      }
      if (await applyShouldHalt(input.commandId)) {
        await persistHalt("canceled");
        return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
      }

      if (await pageLooksFinished(activePage)) {
        await persistAlreadyApplied(activePage, { alreadyAppliedPage: true, duringStep: step });
        return { stopReason: "already_applied", applicationId: application.id, artifacts: artifactCtx.paths };
      }

      const detectedStepBlocker = fixture
        ? null
        : await detectBrowserBlocker(activePage, siteFromUrl(activePage.url()));
      const legacyStepBlocked = detectedStepBlocker ? null : await adapter.detectBlocked(activePage);
      if (detectedStepBlocker || legacyStepBlocked?.blocked) {
        const blocker = detectedStepBlocker ?? {
          kind: "captcha" as const,
          site: siteFromUrl(activePage.url()),
          pageUrl: activePage.url(),
          message: legacyStepBlocked!.reason,
          evidence: legacyStepBlocked!.reason,
        };
        const outcome = await handlePageBlocker(activePage, blocker, `blocked-step-${step}`);
        if (outcome === "blocked") {
          return { stopReason: "blocked", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        if (outcome === "canceled") {
          await persistHalt("canceled");
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        if (outcome === "time_limit") {
          await persistHalt("application_time_limit");
          return { stopReason: "time_limit", applicationId: application.id, artifacts: artifactCtx.paths };
        }
      }

      const { frame } = await resolveFormRoot(activePage, adapter.allowedApplyHosts);
      if (mode !== "dry_run") {
        if (resumePath) {
          const attached = await attachResumeFile(frame, resumePath, input.page);
          if (attached) resumeUploaded = true;
        }
        if (resumeUploaded || !(await resumeDropzoneNeedsFile(frame))) {
          await clearCoverLetterUploads(frame);
        }
        if (resumePath && (await resumeDropzoneNeedsFile(frame))) {
          const attached = await attachResumeFile(frame, resumePath, input.page);
          if (attached) resumeUploaded = true;
        }
      }
      let fields = await detectFields(frame);
      if (mode !== "dry_run") {
        fields = await expandComboboxOptions(frame, fields);
      }
      // Applying takes the model ahead of scoring: there is an employer's form open and
      // waiting. Held across the whole classification pass rather than per call, so a
      // scoring request cannot slip in between two questions of the same form.
      const enhanced = (await withOllamaLock("applying", () =>
        enhanceFieldsWithOllama(fields, matchSettings, {
          maxCalls: 5,
          minConfidence: 0.55,
        }),
      )) ?? { fields, calls: 0, available: false };
      fields = enhanced.fields;
      let llmCalls = enhanced.calls;

      let fingerprint = fieldFingerprint(fields, frame.url());
      let justClearedTransientLoad = false;

      // The page is exactly as it was after we clicked to advance, which means the form
      // refused and said nothing about it. Indeed does this on its screening-questions
      // step: required radio groups with hashed names like q_ba7addb345ecad, no error
      // shown, no navigation, Continue simply inert.
      //
      // Retrying was pointless and hid the cause. It clicked Continue for every remaining
      // step and then reported "max_steps", which reads like a timeout and says nothing
      // about the four unanswered questions that were the actual problem.
      if (
        clickedWithoutProgress &&
        fingerprint === previousFingerprint &&
        (await looksLikeTransientLoad(frame))
      ) {
        const wait = await waitOutTransientLoad(frame, {
          budgetMs: 45_000,
          shouldHalt: () => applyShouldHalt(input.commandId),
        });
        if (wait === "aborted") {
          await persistHalt("canceled");
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        const afterSpinner = await stopFromChallenge(
          await resolvePauseOrChallenge(activePage, `blocked-step-${step}-after-spinner`),
          "apply_paused",
        );
        if (afterSpinner) return afterSpinner;
        // Same logical step: the wait used a time budget, not another JOB_APPLY_MAX_STEPS
        // iteration. Re-scan so a review page that just finished loading still gets filled.
        fields = await detectFields(frame);
        if (mode !== "dry_run") {
          fields = await expandComboboxOptions(frame, fields);
        }
        const enhancedAfterLoad =
          (await withOllamaLock("applying", () =>
            enhanceFieldsWithOllama(fields, matchSettings, {
              maxCalls: 5,
              minConfidence: 0.55,
            }),
          )) ?? { fields, calls: 0, available: false };
        fields = enhancedAfterLoad.fields;
        llmCalls = enhancedAfterLoad.calls;
        fingerprint = fieldFingerprint(fields, frame.url());
        justClearedTransientLoad = wait === "cleared";
      }

      const asks: Array<{ field: DetectedField; reason: string }> = [];
      const usedAnswerIds: string[] = [];
      let skipFillBecauseFormRefused = false;
      let resumeCardsRepaired = false;

      const locationExtras = {
        state: answers.find((answer) => answer.category === "state")?.answerValue ?? null,
        postalCode: answers.find((answer) => answer.category === "zip")?.answerValue ?? null,
      };

      // Populated once below, before any field is actually filled: every question this
      // page has that the deterministic matcher cannot answer, resolved in one call
      // against the answer bank rather than one call per field. A computed question — a
      // date, not a fact — never reaches this at all; it is resolved without asking
      // anyone, human or model, because the answer changes every day and there is
      // nothing to look up.
      const retrievedByFieldId = new Map<string, FieldSuggestion>();

      const applyOneField = async (field: DetectedField) => {
        let suggestion = buildSuggestion(field, answers, matchSettings, {
          company: input.job.company,
        });
        let suggestedValue = suggestion.suggestedValue || undefined;
        let dropdownMapped = false;
        if (
          suggestedValue &&
          enhanced.available &&
          field.options.length > 0 &&
          !optionMatches(field.options, suggestedValue) &&
          llmCalls < 5
        ) {
          llmCalls += 1;
          const mapped = await withOllamaLock("applying", () =>
            mapDropdownWithOllama(field, suggestedValue!, matchSettings),
          );
          if (mapped) {
            suggestedValue = mapped;
            dropdownMapped = true;
          }
        }
        let action = decideFieldAction({
          field,
          match: suggestion.match,
          savedAnswer: suggestion.savedAnswer,
          suggestedValue,
          trustLlmAnswers: cfg.JOB_APPLY_TRUST_LLM_ANSWERS,
          dropdownMapped,
        });
        if (action.kind === "ask") {
          // Resolved already, once, for every question this page had — not here. A
          // per-field call at this point is exactly what made a busy screening step burn
          // through the whole application's call budget before reaching its later fields.
          const retrieved = retrievedByFieldId.get(field.id);
          if (retrieved?.suggestedValue) {
            suggestion = retrieved;
            suggestedValue = retrieved.suggestedValue;
            dropdownMapped = false;
            if (
              field.options.length > 0 &&
              !optionMatches(field.options, suggestedValue)
            ) {
              const mapped = await withOllamaLock("applying", () =>
                mapDropdownWithOllama(field, suggestedValue!, matchSettings),
              );
              if (mapped) {
                suggestedValue = mapped;
                dropdownMapped = true;
              }
            }
            action = decideFieldAction({
              field,
              match: suggestion.match,
              savedAnswer: suggestion.savedAnswer,
              suggestedValue,
              trustLlmAnswers: cfg.JOB_APPLY_TRUST_LLM_ANSWERS,
              dropdownMapped,
            });
          }
        }
        plan.push({
          step,
          selector: field.selector,
          category: field.fieldCategory,
          action,
          label: field.labelText,
        });

        if (mode === "dry_run") return;
        if (action.kind === "ask") {
          if (fieldLooksAnswered(field)) return;
          asks.push({ field, reason: action.reason });
          return;
        }
        if (action.kind === "skip") {
          if (field.fieldCategory === "resume_upload") {
            sawResumeUploadField = true;
            await clearCoverLetterUploads(frame);
            if (field.currentValue === "File selected") {
              resumeUploaded = true;
            } else if (resumePath && !resumeUploaded) {
              const attached = await attachResumeFile(frame, resumePath, input.page);
              if (attached) {
                resumeUploaded = true;
              } else {
                logger.warn("Resume upload failed; continuing without it", {
                  jobId: input.job.id,
                  selector: field.selector,
                });
              }
            }
          }
          return;
        }

        const filled = await fillDetectedField(
          frame,
          field,
          action.value,
          human,
          // A work/education city belongs to that resume entry. Falling back to the
          // candidate's current state or ZIP could turn "Copenhagen" into
          // "Copenhagen, NY" when Indeed's autocomplete misses the first query.
          isHistoricalResumeLocationField(field) ? {} : locationExtras,
        ).catch((error: unknown) => ({
          ok: false as const,
          reason: error instanceof Error ? error.message : String(error),
        }));
        if (!filled.ok) {
          if (fieldLooksAnswered(field)) return;
          asks.push({ field, reason: filled.reason });
          return;
        }
        if (suggestion.savedAnswer) usedAnswerIds.push(suggestion.savedAnswer.id);
        await sleep(fixture ? 10 : interFieldDelayMs(random));
      };

      const incompleteCards = await listIncompleteResumeCards(frame);
      if (incompleteCards.length) {
        logger.info("Indeed resume-detail cards need locations", {
          jobId: input.job.id,
          headings: incompleteCards.map((card) => card.heading),
        });
      }
      if (incompleteCards.length && mode !== "dry_run") {
        await addCommandEvent(
          input.commandId,
          "apply_resume_cards",
          `Opening ${incompleteCards.length} incomplete Indeed resume card(s).`,
          { jobId: input.job.id, headings: incompleteCards.map((card) => card.heading) },
        );
        for (const card of incompleteCards) {
          const before = new Set((await detectFields(frame)).map((field) => field.selector));
          const opened = await clickResumeCardEdit(frame, card);
          const resolved = resolveResumeCardLocation(card, answers, resumeEntries);
          if (!opened) {
            if (!resolved) asks.push(...pendingAsksFromResumeCards([card], answers));
            continue;
          }
          await sleep(fixture ? 20 : 800);
          let editorFields = (await detectFields(frame)).filter((field) => !before.has(field.selector));
          if (!editorFields.length) {
            editorFields = (await detectFields(frame)).filter((field) => {
              const contextual = withResumeCardContext(field, card);
              return (
                isHistoricalResumeLocationField(contextual) ||
                ["city", "state", "zip", "country", "address"].includes(field.fieldCategory) ||
                /\blocation|city|state|country\b/i.test(field.labelText)
              );
            });
          }
          if (editorFields.length) {
            editorFields = await expandComboboxOptions(frame, editorFields);
          }
          const locationFields = editorFields
            .map((field) => withResumeCardContext(field, card))
            .filter(
              (field) =>
                isHistoricalResumeLocationField(field) ||
                ["city", "state", "zip", "country", "address"].includes(field.fieldCategory) ||
                /\blocation|city|state|country\b/i.test(field.labelText),
            );
          if (!resolved) {
            asks.push(...pendingAsksFromResumeCards([card], answers));
            continue;
          }
          if (!locationFields.length) {
            asks.push({
              field: syntheticLocationField(card),
              reason:
                "A resume location exists for this entry, but no location field was found after opening the card.",
            });
            continue;
          }
          let fillFailed = false;
          for (const field of locationFields) {
            const value = locationValueForField(field, resolved.value);
            const filled = await fillDetectedField(frame, field, value, human, {
              acceptTypedLocation: true,
            });
            if (!filled.ok) {
              asks.push({ field, reason: filled.reason });
              fillFailed = true;
              break;
            }
          }
          if (fillFailed) continue;
          resumeCardsRepaired = (await clickResumeCardSave(frame)) || resumeCardsRepaired;
          await sleep(fixture ? 10 : 300);
        }
        fields = await detectFields(frame);
        fingerprint = fieldFingerprint(fields, frame.url());
        if (asks.length) skipFillBecauseFormRefused = true;
      }

      if (
        shouldTreatPageAsUnchangedStall({
          clickedWithoutProgress,
          fingerprint,
          previousFingerprint,
          justClearedTransientLoad,
        })
      ) {
        if (!asks.length) asks.push(...pendingAsksWhenFormRefused(fields));
        if (!asks.length) {
          asks.push(...pendingAsksFromResumeCards(await listIncompleteResumeCards(frame), answers));
        }
        if (!asks.length && resumeCardsRepaired) {
          skipFillBecauseFormRefused = true;
        } else if (!asks.length) {
          const unanswered = fields.filter(
            (field) => field.required && !String(field.currentValue ?? "").trim(),
          );
          const resumeMissing = await resumeDropzoneNeedsFile(frame);
          const detail = resumeMissing
            ? "Resume was not attached, so the form would not advance."
            : unanswered.length
            ? `The form would not advance. ${unanswered.length} required field(s) are unanswered: ${unanswered
                .map((field) => field.labelText || field.name || field.fieldCategory)
                .filter(Boolean)
                .slice(0, 5)
                .join("; ")}`
            : "The form would not advance and no unanswered required field was visible.";
          await upsertApplication({
            userId: input.userId,
            jobId: input.job.id,
            status: "needs_manual",
            stopReason: detail,
          });
          await addCommandEvent(input.commandId, "apply_form_refused", detail, {
            jobId: input.job.id,
            url: frame.url(),
            unanswered: unanswered.map((field) => field.labelText || field.name),
          });
          await finishTrace(artifactCtx, true);
          return { stopReason: "stalled", applicationId: application.id, artifacts: artifactCtx.paths };
        } else {
          skipFillBecauseFormRefused = true;
        }
      }

      if (!skipFillBecauseFormRefused) {
        // One retrieval call for the whole page, made before any field is actually
        // filled. Which fields need it is found the cheap way first — the same
        // deterministic buildSuggestion/decideFieldAction pass applyOneField makes for
        // real a moment later — so the model is only ever asked about a question nothing
        // else could already answer, and asked about all of them together.
        if (enhanced.available && llmCalls < 5) {
          const needsRetrieval = fields.filter((field) => {
            if (computedAnswerFor(field)) return false;
            const cheap = buildSuggestion(field, answers, matchSettings, {
              company: input.job.company,
            });
            const action = decideFieldAction({
              field,
              match: cheap.match,
              savedAnswer: cheap.savedAnswer,
              suggestedValue: cheap.suggestedValue || undefined,
              trustLlmAnswers: cfg.JOB_APPLY_TRUST_LLM_ANSWERS,
              dropdownMapped: false,
            });
            return action.kind === "ask";
          });
          if (needsRetrieval.length) {
            llmCalls += 1;
            const batch = (await withOllamaLock("applying", () =>
              retrieveAnswersWithOllamaBatch(needsRetrieval, answers, matchSettings),
            )) ?? new Map<string, FieldSuggestion>();
            for (const [fieldId, suggestion] of batch) retrievedByFieldId.set(fieldId, suggestion);
          }
        }

        for (const field of fields) {
          const held = await holdIfUserPaused(activePage);
          const heldStop = await stopFromChallenge(held, "user_paused");
          if (heldStop) return heldStop;
          await applyOneField(field);
        }
      }

      // Reuse counters are diagnostic only — never let them fail an application.
      if (usedAnswerIds.length) {
        try {
          await markAnswersUsed(usedAnswerIds);
        } catch (error) {
          logger.warn("Could not update answer reuse counters", {
            commandId: input.commandId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const stepScreenshotPath = await screenshot(artifactCtx, `step-${step}`);

      if (await looksLikeTransientLoad(frame)) {
        const wait = await waitOutTransientLoad(frame, {
          budgetMs: 75_000,
          shouldHalt: () => applyShouldHalt(input.commandId),
        });
        if (wait === "aborted") {
          await persistHalt("canceled");
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        // Image CAPTCHA often lands on the review page the moment this overlay clears.
        const afterLoad = await stopFromChallenge(
          await resolvePauseOrChallenge(activePage, `blocked-step-${step}-after-load`),
          "apply_paused",
        );
        if (afterLoad) return afterLoad;
        // Still spinning after a long wait: do not identity-check or click a Submit that
        // belongs to the overlay. Stay on this logical step by skipping the rest of the
        // iteration only after the captcha check above had a chance to pause in place.
        if (wait !== "cleared" || (await looksLikeTransientLoad(frame))) {
          previousFingerprint = fingerprint;
          clickedWithoutProgress = false;
          continue;
        }
      } else {
        const midStepChallenge = await stopFromChallenge(
          await resolvePauseOrChallenge(activePage, `blocked-step-${step}-before-advance`),
          "apply_paused",
        );
        if (midStepChallenge) return midStepChallenge;
      }

      if (mode === "dry_run") {
        await writePlanArtifact(artifactCtx, plan);
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "ready",
          stopReason: "dry_run",
          notes: `Dry-run plan with ${plan.length} field decisions.`,
        });
        await finishTrace(artifactCtx, false);
        return { stopReason: "dry_run", applicationId: application.id, artifacts: artifactCtx.paths };
      }

      if (asks.length && resumeAdvance) {
        // Resume means keep going on this tab. The detector may still "ask" for a
        // question the person already answered on Indeed; exiting as needs_answers
        // used to complete the command and let the next apply close this page.
        resumeAdvance = false;
      } else if (asks.length) {
        if (!waitedForAnswers) {
          waitedForAnswers = true;
          const channel = resolveNotifyChannel(cfg);
          const ttlMs = cfg.JOB_APPLY_QUESTION_TTL_HOURS * 60 * 60 * 1000;
          const expiresAt = new Date(Date.now() + ttlMs);
          // Record every gap first, then raise a single notification for the whole
          // application — one alert listing N questions, not N alerts.
          const recorded: Array<{ rowId: string; summary: PendingQuestionSummary }> = [];
          for (const ask of asks) {
            const id = shortId();
            const [pending] = await database
              .insert(schema.pendingQuestions)
              .values({
                shortId: id,
                commandId: input.commandId,
                jobId: input.job.id,
                applicationId: application.id,
                userId: input.userId,
                fieldId: ask.field.id,
                fieldSelector: ask.field.selector,
                questionText: ask.field.labelText,
                normalizedQuestion: ask.field.normalizedQuestion,
                category: ask.field.fieldCategory,
                answerType: ask.field.inputType,
                optionsJson: ask.field.options,
                required: ask.field.required,
                riskLevel: ask.field.riskLevel,
                status: "open",
                channel: channel.name,
                contextJson: {
                  applyUrl: activePage.url(),
                  stepIndex: step,
                  screenshotPath: stepScreenshotPath,
                  askReason: ask.reason,
                },
                expiresAt,
              })
              .returning();
            if (pending) {
              recorded.push({
                rowId: pending.id,
                summary: {
                  shortId: id,
                  questionText: ask.field.labelText,
                  options: ask.field.options,
                  required: ask.field.required,
                },
              });
            }
          }

          const notified = await channel.notifyQuestions({
            jobTitle: input.job.title,
            company: input.job.company,
            questions: recorded.map((item) => item.summary),
          });
          for (const item of recorded) {
            const messageId = notified.messageIds?.[item.summary.shortId];
            if (!messageId) continue;
            await database
              .update(schema.pendingQuestions)
              .set({ channelMessageId: messageId, updatedAt: new Date() })
              .where(eq(schema.pendingQuestions.id, item.rowId));
          }

          await addCommandEvent(
            input.commandId,
            "apply_needs_answers",
            `Paused apply for ${asks.length} unanswered field(s). The tab stays open — answer them on the site if you want, then click Resume. Filling the page does not continue the apply.`,
            { jobId: input.job.id, count: asks.length },
          );
        }

        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "awaiting_answer",
          stopReason: `Needs answers: ${asks.map((item) => item.field.labelText).join("; ")}`,
          applyUrl: activePage.url(),
        });

        const wait = await waitForPendingAnswers({
          isPaused: () => isApplyPaused(input.userId),
          setPaused: (paused) => setApplyPaused(input.userId, paused),
          shouldHalt: async () =>
            (await applyShouldHalt(input.commandId)) ||
            Boolean(input.deadlineAt && Date.now() >= input.deadlineAt),
        });
        if (wait === "aborted") {
          if (input.deadlineAt && Date.now() >= input.deadlineAt) {
            await persistHalt("application_time_limit");
            await finishTrace(artifactCtx, true);
            return { stopReason: "time_limit", applicationId: application.id, artifacts: artifactCtx.paths };
          }
          await persistHalt("canceled");
          await finishTrace(artifactCtx, true);
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }

        const refreshed = await loadAnswerBankWithContext({
          userId: input.userId,
          jobId: input.job.id,
          company: input.job.company,
          domain: (() => {
            try {
              return new URL(input.job.sourceUrl).hostname;
            } catch {
              return "";
            }
          })(),
          jobLocation: input.job.location,
          remoteType: input.job.remoteType,
          salaryText: input.job.salaryText,
          jobTitle: input.job.title,
          employmentType: input.job.employmentType,
          visaSignal: input.job.visaSignal,
        });
        answers.splice(0, answers.length, ...refreshed.answers);
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "filling",
          stopReason: "human_resumed",
          applyUrl: activePage.url(),
        });
        await addCommandEvent(
          input.commandId,
          "apply_answers_resumed",
          "Resume pressed; continuing this form.",
          { jobId: input.job.id, wait },
        );
        resumeAdvance = true;
        step -= 1;
        continue;
      }

      // On an employer's form the model looks first; on the boards it is never consulted,
      // because those are rehearsed and paying inference to rediscover a known button on
      // every application would give back the pacing work outright.
      const external = onExternalSite
        ? await findExternalAdvanceControl(frame, activePage, () =>
            adapter.findAdvanceControl(frame),
          )
        : null;
      let advance = external
        ? {
            locator: external.selector
              ? frame.locator(external.selector).first()
              : (external.locator as ReturnType<typeof frame.locator>),
            // Re-derived from the label rather than trusted, so a model that calls
            // "Save and close" a submit cannot make it one.
            isTerminalSubmit: controlIsSafeToSubmit(external),
          }
        : await adapter.findAdvanceControl(frame);
      if (advance?.isTerminalSubmit) {
        const bodyText = await frame.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
        if (wizardStepIsIncomplete(bodyText)) {
          advance = { ...advance, isTerminalSubmit: false };
        }
      }
      if (!advance) {
        if (fingerprint === previousFingerprint) {
          stallRetries += 1;
          if (stallRetries >= 2) {
            await upsertApplication({
              userId: input.userId,
              jobId: input.job.id,
              status: "needs_manual",
              stopReason: "stalled",
            });
            await finishTrace(artifactCtx, true);
            return { stopReason: "stalled", applicationId: application.id, artifacts: artifactCtx.paths };
          }
        }
        previousFingerprint = fingerprint;
        continue;
      }

      if (advance.isTerminalSubmit) {
        // Checked on every site, not only employer ones — the bug this closes was found on
        // Indeed. A resumed application can land past the contact-info step entirely, so
        // the run that is about to submit may never have visited the page holding the name
        // fields this time; a stale value from the board's own account profile would go
        // out unexamined.
        if (mode === "fill_and_submit") {
          const identity = await verifyIdentityBeforeSubmit(
            frame,
            fields,
            human,
            expectedFirstName,
            expectedLastName,
            identityConfirmedThisRun,
          );
          if (!identity.verified) {
            await upsertApplication({
              userId: input.userId,
              jobId: input.job.id,
              status: "needs_manual",
              stopReason: identity.reason,
            });
            await addCommandEvent(input.commandId, "identity_unverified", identity.reason, {
              jobId: input.job.id,
              url: frame.url(),
            });
            await finishTrace(artifactCtx, true);
            return { stopReason: "needs_manual", applicationId: application.id, artifacts: artifactCtx.paths };
          }
          identityConfirmedThisRun = true;
          if (identity.corrected) {
            // One action before an irreversible click. Re-scan next iteration and confirm
            // clean rather than clicking submit in the same pass as the fix.
            previousFingerprint = fingerprint;
            clickedWithoutProgress = false;
            await sleep(fixture ? 10 : interFieldDelayMs(random));
            continue;
          }
        }

        // The last check before something that cannot be taken back, and only on employer
        // sites — the boards keep the checks they already had. A model may have found this
        // button; it does not get to decide that it may be pressed.
        if (onExternalSite) {
          const decision = decideSubmission({
            mode,
            unansweredRequiredFields: asks.filter((ask) => ask.field.required).length,
            openQuestions: asks.length,
            blocked: false,
            proposedByModel: external?.proposedByModel ?? false,
            looksTerminal: advance.isTerminalSubmit,
            // Whether the upload actually succeeded, not merely whether a resume was
            // available to try. A form that never showed a resume field at all — some
            // employer sites pull it from an existing profile — is not held for this;
            // one that showed the field and never got a file into it is.
            resumeAttached: resumeUploaded || !sawResumeUploadField,
            score: match?.score ?? null,
            minScore: cfg.JOB_APPLY_EXTERNAL_MIN_SCORE,
          });
          if (!decision.submit) {
            await upsertApplication({
              userId: input.userId,
              jobId: input.job.id,
              status: "needs_manual",
              stopReason: decision.reason,
            });
            await addCommandEvent(
              input.commandId,
              "external_submit_withheld",
              decision.reason,
              { jobId: input.job.id, proposedByModel: external?.proposedByModel ?? false },
            );
            await finishTrace(artifactCtx, true);
            return { stopReason: "needs_manual", applicationId: application.id, artifacts: artifactCtx.paths };
          }
        }
        const pauseBeforeSubmit = await resolvePauseOrChallenge(activePage, "blocked-before-submit");
        if (pauseBeforeSubmit === "paused") {
          await upsertApplication({
            userId: input.userId,
            jobId: input.job.id,
            status: "needs_manual",
            stopReason: "apply_paused_before_submit",
          });
          await finishTrace(artifactCtx, true);
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        if (pauseBeforeSubmit === "blocked") {
          return { stopReason: "blocked", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        if (pauseBeforeSubmit === "canceled") {
          await persistHalt("canceled");
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        if (pauseBeforeSubmit === "time_limit") {
          await persistHalt("application_time_limit");
          return { stopReason: "time_limit", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        if (input.deadlineAt && Date.now() >= input.deadlineAt) {
          await upsertApplication({
            userId: input.userId,
            jobId: input.job.id,
            status: "needs_manual",
            stopReason: "application_time_limit_before_submit",
          });
          await finishTrace(artifactCtx, true);
          return { stopReason: "time_limit", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        if (mode === "fill_only") {
          await screenshot(artifactCtx, "98-before-submit");
          await upsertApplication({
            userId: input.userId,
            jobId: input.job.id,
            status: "filling",
            stopReason: "filled_not_submitted",
          });
          await finishTrace(artifactCtx, true);
          return {
            stopReason: "filled_not_submitted",
            applicationId: application.id,
            artifacts: artifactCtx.paths,
          };
        }

        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "submitting",
          submittedAt: new Date(),
          applyUrl: activePage.url(),
        });
        submittingWritten = true;
        markInFlightSubmitting();
        // Crash simulation for tests — must leave submission_unknown if we never confirm.
        if (input.crashAfterSubmittingWrite) {
          await upsertApplication({
            userId: input.userId,
            jobId: input.job.id,
            status: "submission_unknown",
            stopReason: "crash_after_submit_write",
            submittedAt: new Date(),
          });
          await finishTrace(artifactCtx, true);
          return { stopReason: "error", applicationId: application.id, artifacts: artifactCtx.paths };
        }

        await screenshot(artifactCtx, "98-before-submit");
        await sleep(preSubmitDelayMs(random));
        if (await applyShouldHalt(input.commandId)) {
          await persistHalt("submit_canceled_before_click");
          submittingWritten = false;
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        const pauseBeforeClick = await resolvePauseOrChallenge(activePage, "blocked-before-submit");
        if (pauseBeforeClick === "paused") {
          await persistHalt("submit_canceled_before_click");
          submittingWritten = false;
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        if (pauseBeforeClick === "blocked") {
          return { stopReason: "blocked", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        if (pauseBeforeClick === "canceled" || pauseBeforeClick === "time_limit") {
          await persistHalt(pauseBeforeClick === "time_limit" ? "application_time_limit" : "canceled");
          submittingWritten = false;
          return {
            stopReason: pauseBeforeClick === "time_limit" ? "time_limit" : "canceled",
            applicationId: application.id,
            artifacts: artifactCtx.paths,
          };
        }
        await advance.locator.click({ timeout: 5000 });
        const wait = await waitOutTransientLoad(frame, {
          budgetMs: 15_000,
          shouldHalt: () => applyShouldHalt(input.commandId),
        });
        if (wait === "aborted") {
          await persistHalt("canceled");
          submittingWritten = false;
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }

        const postSubmitBlocker = fixture
          ? null
          : await detectBrowserBlocker(activePage, siteFromUrl(activePage.url()));
        if (postSubmitBlocker) {
          const outcome = await handlePageBlocker(activePage, postSubmitBlocker, "blocked-after-submit");
          if (outcome === "blocked") {
            return { stopReason: "blocked", applicationId: application.id, artifacts: artifactCtx.paths };
          }
          if (outcome === "canceled") {
            await persistHalt("canceled");
            return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
          }
          if (outcome === "time_limit") {
            await persistHalt("application_time_limit");
            return { stopReason: "time_limit", applicationId: application.id, artifacts: artifactCtx.paths };
          }
        }

        let success = await adapter.detectSuccess(activePage);
        for (let attempt = 0; attempt < 4 && !success; attempt += 1) {
          const retryBlocker = fixture
            ? null
            : await detectBrowserBlocker(activePage, siteFromUrl(activePage.url()));
          if (retryBlocker && challengeNeedsHuman(retryBlocker.kind)) {
            const outcome = await handlePageBlocker(activePage, retryBlocker, "blocked-after-submit");
            if (outcome === "blocked") {
              return { stopReason: "blocked", applicationId: application.id, artifacts: artifactCtx.paths };
            }
            if (outcome === "canceled") {
              await persistHalt("canceled");
              return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
            }
            if (outcome === "time_limit") {
              await persistHalt("application_time_limit");
              return { stopReason: "time_limit", applicationId: application.id, artifacts: artifactCtx.paths };
            }
            success = await adapter.detectSuccess(activePage);
            continue;
          }
          await sleep(1_500);
          success = await adapter.detectSuccess(activePage);
        }
        await screenshot(artifactCtx, "99-after-submit");
        if (success) {
          // Only the application row is written. `jobs` is shared across users and has no
          // user_id, so stamping an outcome there would tell every other user that they
          // had applied. Per-user outcome lives in applications; job lists resolve it
          // through that table.
          await database
            .update(schema.applications)
            .set({
              status: "applied",
              appliedAt: new Date(),
              confirmationEvidence: { detected: true },
              stopReason: "submitted",
              updatedAt: new Date(),
            })
            .where(eq(schema.applications.id, application.id));
          await finishTrace(artifactCtx, false);
          return { stopReason: "submitted", applicationId: application.id, artifacts: artifactCtx.paths };
        }

        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "submission_unknown",
          stopReason: "submit_unconfirmed",
          submittedAt: new Date(),
        });
        await finishTrace(artifactCtx, true);
        return { stopReason: "error", applicationId: application.id, artifacts: artifactCtx.paths };
      }

      if (fingerprint === previousFingerprint) {
        stallRetries += 1;
        if (stallRetries >= 2) {
          await upsertApplication({
            userId: input.userId,
            jobId: input.job.id,
            status: "needs_manual",
            stopReason: "stalled",
          });
          await finishTrace(artifactCtx, true);
          return { stopReason: "stalled", applicationId: application.id, artifacts: artifactCtx.paths };
        }
      } else {
        stallRetries = 0;
      }
      previousFingerprint = fingerprint;
      clickedWithoutProgress = true;
      const beforeAdvance = await stopFromChallenge(
        await resolvePauseOrChallenge(activePage, `blocked-before-advance-${step}`),
        "apply_paused",
      );
      if (beforeAdvance) return beforeAdvance;
      await advance.locator.click({ timeout: 5000 });
      await sleep(humanDelayMs({ minDelayMs: 1800, maxDelayMs: 3200 }, random));
    }

    await upsertApplication({
      userId: input.userId,
      jobId: input.job.id,
      status: "needs_manual",
      stopReason: "max_steps",
    });
    await finishTrace(artifactCtx, true);
    return { stopReason: "stalled", applicationId: application.id, artifacts: artifactCtx.paths };
  } catch (error) {
    logger.warn("applyToJob failed", {
      jobId: input.job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await upsertApplication({
      userId: input.userId,
      jobId: input.job.id,
      status: statusAfterApplyFailure(submittingWritten),
      stopReason: error instanceof Error ? error.message : "error",
    }).catch(() => undefined);
    await finishTrace(artifactCtx, true);
    return { stopReason: "error", applicationId: application.id, artifacts: artifactCtx.paths };
  } finally {
    clearInFlightApply();
    artifacts.push(...artifactCtx.paths);
  }
}
