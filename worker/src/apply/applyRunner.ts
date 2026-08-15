import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import type { BrowserContextLike, FrameLike, PageLike } from "../browser/playwrightTypes";
import { getConfig, sleep } from "../config";
import { addCommandEvent, getCommandStatus, getWorkerDb } from "../db";
import { loadAnswerBankWithContext, markAnswersUsed } from "../formfill/answerBank";
import {
  detectFields,
  expandComboboxOptions,
  resolveFormRoot,
} from "../formfill/domDetector";
import {
  buildSuggestion,
  enhanceFieldsWithOllama,
  mapDropdownWithOllama,
} from "../formfill/suggestions";
import { optionMatches } from "../formfill/optionMatching";
import type { DetectedField, MatchSettings } from "../formfill/types";
import { logger } from "../logger";
import { detectBrowserBlocker, siteFromUrl } from "../browser/blockerDetection";
import { reportBrowserBlocker } from "../browser/reportBlocker";
import { resolveNotifyChannel, type PendingQuestionSummary } from "../notify";
import { humanDelayMs } from "../search/browserDiscovery";
import { materializeResume } from "../resume/materialize";
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
} from "./applyEligibility";
import { adapterFor, isExternalAts, sourceUrlAllowed } from "./applySteps";
import { decideExternalSiteApply } from "./externalSitePolicy";
import {
  classifyExternalPage,
  controlIsSafeToSubmit,
  findExternalAdvanceControl,
  needsHuman,
} from "./external/externalApply";
import { decideSubmission } from "./external/submissionGuard";
import { withOllamaLock } from "../ai/ollamaLock";
import { fillDetectedField, type HumanTyping } from "./fillField";
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
const TRANSIENT_LOAD_TEXT = /preparing (your )?review|please wait|processing your|submitting your|loading\b|one moment/i;

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
    '[role="progressbar"], [class*="spinner" i], [class*="loading" i][aria-hidden="false"]',
  );
  if ((await spinner.count().catch(() => 0)) > 0) {
    if (await spinner.first().isVisible({ timeout: 500 }).catch(() => false)) return true;
  }
  return (await frame.getByText(TRANSIENT_LOAD_TEXT).count().catch(() => 0)) > 0;
}

export type IdentityCheck =
  | { verified: true; corrected: boolean }
  | { verified: false; reason: string };

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
 * So this is not a fill-time fix, it is a pre-submit gate, and it runs regardless of
 * which step happened to hold the name fields this time. Three outcomes: editable name
 * fields are on the current page and already correct — verified. They are on the page and
 * wrong — corrected in place. Neither editable fields nor matching visible text can be
 * found — refused, because submitting a name that cannot be confirmed is worse than
 * holding the application for a person.
 */
export async function verifyIdentityBeforeSubmit(
  frame: FrameLike,
  fields: DetectedField[],
  human: HumanTyping,
  expectedFirstName: string | null,
  expectedLastName: string | null,
): Promise<IdentityCheck> {
  if (!expectedFirstName && !expectedLastName) {
    // No profile name on file at all is a data problem for the profile page, not
    // something this run can resolve mid-application.
    return { verified: false, reason: "No first or last name is on file to verify against." };
  }

  const firstField = fields.find((f) => f.fieldCategory === "first_name");
  const lastField = fields.find((f) => f.fieldCategory === "last_name");

  if (firstField || lastField) {
    let corrected = false;
    if (expectedFirstName && firstField && firstField.currentValue.trim() !== expectedFirstName) {
      await fillDetectedField(frame, firstField, expectedFirstName, human);
      corrected = true;
    }
    if (expectedLastName && lastField && lastField.currentValue.trim() !== expectedLastName) {
      await fillDetectedField(frame, lastField, expectedLastName, human);
      corrected = true;
    }
    return { verified: true, corrected };
  }

  // No editable fields on this page — likely a review screen after a resumed flow.
  // Fall back to visible text: if the expected name appears verbatim, that is real
  // confirmation, not a guess.
  const fullName = [expectedFirstName, expectedLastName].filter(Boolean).join(" ").trim();
  if (fullName) {
    const found = await frame.getByText(fullName, { exact: false }).count().catch(() => 0);
    if (found > 0) return { verified: true, corrected: false };
  }

  return {
    verified: false,
    reason: "Could not find an editable name field or matching name text to confirm before submitting.",
  };
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

  try {
    if (await getCommandStatus(input.commandId) === "canceled") {
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
    await sleep(
      fixture
        ? 50
        : humanDelayMs(
            {
              minDelayMs: Math.min(cfg.JOB_BROWSER_MIN_DELAY_MS, 1500),
              maxDelayMs: Math.min(cfg.JOB_BROWSER_MAX_DELAY_MS, 3000),
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
        applyUrl: input.page.url(),
      });
      await screenshot(artifactCtx, "blocked");
      await finishTrace(artifactCtx, true);
      return { stopReason: "blocked", applicationId: application.id, artifacts: artifactCtx.paths };
    }

    const applyButton = await adapter.findApplyButton(input.page);
    if (applyButton) {
      await applyButton.click({ timeout: 5000 });
      await sleep(800 + random() * 700);
    }

    const pages = input.browserContext.pages();
    const activePage = pages[pages.length - 1] ?? input.page;
    artifactCtx.page = activePage;
    const applyUrl = activePage.url();
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
    // The profile's own name, for the identity check right before submit. Read from the
    // same answer bank everything else uses rather than a fresh profile fetch, so this
    // can never disagree with what the rest of the run considers correct.
    const expectedFirstName = answers.find((a) => a.category === "first_name")?.answerValue?.trim() || null;
    const expectedLastName = answers.find((a) => a.category === "last_name")?.answerValue?.trim() || null;
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
    /** Consecutive steps spent waiting out a loading screen, bounded so a page that is
     *  genuinely stuck — not just slow — still reaches the ordinary stall verdict. */
    let loadingGrace = 4;

    for (let step = 0; step < cfg.JOB_APPLY_MAX_STEPS; step += 1) {
      if (await isApplyPaused(input.userId)) {
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "needs_manual",
          stopReason: "apply_paused",
        });
        await finishTrace(artifactCtx, true);
        return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
      }
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
      if (await getCommandStatus(input.commandId) === "canceled") {
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "needs_manual",
          stopReason: "canceled",
        });
        await finishTrace(artifactCtx, true);
        return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
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
          applyUrl: activePage.url(),
        });
        await screenshot(artifactCtx, `blocked-step-${step}`);
        await finishTrace(artifactCtx, true);
        return { stopReason: "blocked", applicationId: application.id, artifacts: artifactCtx.paths };
      }

      const { frame } = await resolveFormRoot(activePage, adapter.allowedApplyHosts);
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

      const fingerprint = fieldFingerprint(fields, frame.url());

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
        loadingGrace > 0 &&
        (await looksLikeTransientLoad(frame))
      ) {
        loadingGrace -= 1;
        await sleep(1_500);
        continue;
      }

      if (clickedWithoutProgress && fingerprint === previousFingerprint) {
        const unanswered = fields.filter(
          (field) => field.required && !String(field.currentValue ?? "").trim(),
        );
        const detail = unanswered.length
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
      }

      const asks: Array<{ field: DetectedField; reason: string }> = [];
      const usedAnswerIds: string[] = [];

      for (const field of fields) {
        const suggestion = buildSuggestion(field, answers);
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
        const action = decideFieldAction({
          field,
          match: suggestion.match,
          savedAnswer: suggestion.savedAnswer,
          suggestedValue,
          trustLlmAnswers: cfg.JOB_APPLY_TRUST_LLM_ANSWERS,
          dropdownMapped,
        });
        plan.push({
          step,
          selector: field.selector,
          category: field.fieldCategory,
          action,
          label: field.labelText,
        });

        if (mode === "dry_run") continue;

        if (action.kind === "ask") {
          asks.push({ field, reason: action.reason });
          continue;
        }
        if (action.kind === "skip") {
          if (
            field.fieldCategory === "resume_upload" &&
            resumePath &&
            field.inputType === "file" &&
            !resumeUploaded &&
            // The detector's own signal that this particular input already has a file,
            // in case a stale duplicate is sitting alongside the live one this step.
            field.currentValue !== "File selected"
          ) {
            try {
              await frame.locator(field.selector).first().setInputFiles(resumePath, {
                timeout: 10_000,
              });
              resumeUploaded = true;
            } catch (error) {
              // Not fatal. The submission guard already refuses to submit without
              // resumeAttached, so a failed upload here is caught at the right place —
              // held for a person — rather than taking the whole application down.
              logger.warn("Resume upload failed; continuing without it", {
                jobId: input.job.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } else if (field.fieldCategory === "resume_upload" && field.currentValue === "File selected") {
            resumeUploaded = true;
          }
          if (field.fieldCategory === "resume_upload") sawResumeUploadField = true;
          continue;
        }

        await fillDetectedField(frame, field, action.value, human);
        if (suggestion.savedAnswer) usedAnswerIds.push(suggestion.savedAnswer.id);
        await sleep(fixture ? 10 : interFieldDelayMs(random));
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

      if (asks.length) {
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

        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "awaiting_answer",
          stopReason: `Needs answers: ${asks.map((item) => item.field.labelText).join("; ")}`,
          applyUrl: activePage.url(),
        });
        await addCommandEvent(
          input.commandId,
          "apply_needs_answers",
          `Paused apply for ${asks.length} unanswered field(s).`,
          { jobId: input.job.id, count: asks.length },
        );
        await finishTrace(artifactCtx, true);
        return { stopReason: "needs_answers", applicationId: application.id, artifacts: artifactCtx.paths };
      }

      // On an employer's form the model looks first; on the boards it is never consulted,
      // because those are rehearsed and paying inference to rediscover a known button on
      // every application would give back the pacing work outright.
      const external = onExternalSite
        ? await findExternalAdvanceControl(frame, activePage, () =>
            adapter.findAdvanceControl(frame),
          )
        : null;
      const advance = external
        ? {
            locator: external.selector
              ? frame.locator(external.selector).first()
              : (external.locator as ReturnType<typeof frame.locator>),
            // Re-derived from the label rather than trusted, so a model that calls
            // "Save and close" a submit cannot make it one.
            isTerminalSubmit: controlIsSafeToSubmit(external),
          }
        : await adapter.findAdvanceControl(frame);
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
        if (await isApplyPaused(input.userId)) {
          await upsertApplication({
            userId: input.userId,
            jobId: input.job.id,
            status: "needs_manual",
            stopReason: "apply_paused_before_submit",
          });
          await finishTrace(artifactCtx, true);
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
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
        if (
          (await isApplyPaused(input.userId)) ||
          (await getCommandStatus(input.commandId)) === "canceled"
        ) {
          await upsertApplication({
            userId: input.userId,
            jobId: input.job.id,
            status: "needs_manual",
            stopReason: "submit_canceled_before_click",
          });
          submittingWritten = false;
          await finishTrace(artifactCtx, true);
          return { stopReason: "canceled", applicationId: application.id, artifacts: artifactCtx.paths };
        }
        await advance.locator.click({ timeout: 5000 });
        await sleep(1500 + random() * 1500);
        const success = await adapter.detectSuccess(activePage);
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
      await advance.locator.click({ timeout: 5000 });
      await sleep(humanDelayMs({ minDelayMs: 1000, maxDelayMs: 2500 }, random));
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
    artifacts.push(...artifactCtx.paths);
  }
}
