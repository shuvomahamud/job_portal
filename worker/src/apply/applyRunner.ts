import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import type { BrowserContextLike, PageLike } from "../browser/playwrightTypes";
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
import { fillDetectedField } from "./fillField";
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
  };
  mode?: ApplyMode;
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
  jobRoleMatchId: string;
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

  const [match] = await database
    .select({
      id: schema.jobRoleMatches.id,
      targetRoleId: schema.jobRoleMatches.targetRoleId,
      resumeVersionId: schema.jobRoleMatches.resumeVersionId,
      score: schema.jobRoleMatches.score,
    })
    .from(schema.jobRoleMatches)
    .innerJoin(schema.targetRoles, eq(schema.targetRoles.id, schema.jobRoleMatches.targetRoleId))
    .where(
      and(
        eq(schema.jobRoleMatches.jobId, input.job.id),
        eq(schema.jobRoleMatches.userId, input.userId),
        eq(schema.jobRoleMatches.status, ELIGIBLE_ROLE_MATCH_STATUS),
        eq(schema.targetRoles.active, true),
      ),
    )
    .orderBy(desc(schema.jobRoleMatches.score))
    .limit(1);

  if (!match?.resumeVersionId) {
    await upsertApplication({
      userId: input.userId,
      jobId: input.job.id,
      status: "needs_manual",
      stopReason: "No eligible role match with a resume.",
    });
    return { stopReason: "needs_manual", artifacts };
  }

  let resumePath: string | null = null;
  const resumeVersionId = match.resumeVersionId;
  if (resumeVersionId) {
    try {
      const material = await materializeResume(resumeVersionId);
      resumePath = material.absolutePath;
    } catch (error) {
      await upsertApplication({
        userId: input.userId,
        jobId: input.job.id,
        status: "needs_manual",
        targetRoleId: match?.targetRoleId,
        jobRoleMatchId: match?.id,
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
    targetRoleId: match.targetRoleId,
    jobRoleMatchId: match.id,
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

    const blocked = await adapter.detectBlocked(input.page);
    if (blocked.blocked) {
      await upsertApplication({
        userId: input.userId,
        jobId: input.job.id,
        status: "blocked",
        stopReason: blocked.reason,
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
    if (external.external && input.job.source !== "fixture") {
      await upsertApplication({
        userId: input.userId,
        jobId: input.job.id,
        status: "needs_manual",
        stopReason: `External ATS host: ${external.host}`,
        applyUrl,
      });
      await finishTrace(artifactCtx, true);
      return { stopReason: "external_ats", applicationId: application.id, artifacts: artifactCtx.paths };
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
    });
    const answers = bank.answers;
    if (bank.addressLabel) {
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

    const human = createHumanTyping(random);
    const plan: Array<Record<string, unknown>> = [];
    let previousFingerprint = "";
    let stallRetries = 0;

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

      const pageBlocked = await adapter.detectBlocked(activePage);
      if (pageBlocked.blocked) {
        await upsertApplication({
          userId: input.userId,
          jobId: input.job.id,
          status: "blocked",
          stopReason: pageBlocked.reason,
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
      const enhanced = await enhanceFieldsWithOllama(fields, matchSettings, {
        maxCalls: 5,
        minConfidence: 0.55,
      });
      fields = enhanced.fields;
      let llmCalls = enhanced.calls;

      const fingerprint = fieldFingerprint(fields, frame.url());
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
          const mapped = await mapDropdownWithOllama(
            field,
            suggestedValue,
            matchSettings,
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
            field.inputType === "file"
          ) {
            await frame.locator(field.selector).first().setInputFiles(resumePath);
          }
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

      const advance = await adapter.findAdvanceControl(frame);
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
          await database.batch([
            database
              .update(schema.applications)
              .set({
                status: "applied",
                appliedAt: new Date(),
                confirmationEvidence: { detected: true },
                stopReason: "submitted",
                updatedAt: new Date(),
              })
              .where(eq(schema.applications.id, application.id)),
            database
              .update(schema.jobs)
              .set({ status: "applied", updatedAt: new Date() })
              .where(eq(schema.jobs.id, input.job.id)),
          ]);
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
