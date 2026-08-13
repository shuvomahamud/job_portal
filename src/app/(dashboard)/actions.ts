"use server";

import { revalidatePath } from "next/cache";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  applications,
  automationSettings,
  candidateAddresses,
  candidateFacts,
  candidateProfiles,
  commandEvents,
  commonAnswers,
  followups,
  jobs,
  pendingQuestions,
  resumeVersions,
  targetRoles,
} from "@/db/schema";
import { requireDashboardUser } from "@/lib/auth";
import {
  FACT_KEYS,
  YEARS_FACT_KEYS,
  normalizeYearsValue,
} from "@/lib/candidateFacts";
import { FOLLOWUP_STATUSES } from "@/lib/constants";
import { isResumeHealthyForActivation } from "@/lib/resumeHealth";
import { followupUpdateSchema } from "@/lib/validation";
import { cancelCommand, createCommand, getCommandDetail } from "@/services/commands";

const requiredString = (formData: FormData, key: string) =>
  String(formData.get(key) ?? "").trim();
const optionalString = (formData: FormData, key: string) => {
  const value = requiredString(formData, key);
  return value || null;
};
const commaList = (formData: FormData, key: string) =>
  requiredString(formData, key)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const hasHttpProtocol = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
const optionalHttpUrl = z
  .url()
  .refine(hasHttpProtocol, {
    message: "Only http and https URLs are allowed.",
  })
  .nullable();

export async function saveCandidateProfile(formData: FormData) {
  const user = await requireDashboardUser();
  const schema = z.object({
    targetLocations: z.array(z.string().min(1).max(200)).max(30),
    workAuthorizationAnswer: z.string().max(5_000).nullable(),
    sponsorshipAnswer: z.string().max(5_000).nullable(),
    salaryExpectation: z.string().max(500).nullable(),
    skills: z.array(z.string().min(1).max(200)).max(100),
    preferredEmploymentTypes: z.array(z.string().min(1).max(100)).max(20),
    dealBreakers: z.array(z.string().min(1).max(300)).max(30),
    matchingInstructions: z.string().max(4_000).nullable(),
    linkedinUrl: optionalHttpUrl,
    githubUrl: optionalHttpUrl,
    portfolioUrl: optionalHttpUrl,
    summary: z.string().max(20_000).nullable(),
    firstName: z.string().trim().max(100).nullable(),
    lastName: z.string().trim().max(100).nullable(),
    phone: z.string().trim().max(40).nullable(),
    addressLine1: z.string().trim().max(200).nullable(),
    addressLine2: z.string().trim().max(200).nullable(),
    city: z.string().trim().max(100).nullable(),
    stateRegion: z.string().trim().max(100).nullable(),
    postalCode: z.string().trim().max(30).nullable(),
    country: z.string().trim().max(100).nullable(),
    currentCompany: z.string().trim().max(200).nullable(),
    currentTitle: z.string().trim().max(200).nullable(),
    yearsTotalExperience: z.number().int().min(0).max(60).nullable(),
  });
  const yearsRaw = optionalString(formData, "yearsTotalExperience");
  const input = schema.parse({
    targetLocations: commaList(formData, "targetLocations"),
    workAuthorizationAnswer: optionalString(
      formData,
      "workAuthorizationAnswer",
    ),
    sponsorshipAnswer: optionalString(formData, "sponsorshipAnswer"),
    salaryExpectation: optionalString(formData, "salaryExpectation"),
    skills: commaList(formData, "skills"),
    preferredEmploymentTypes: commaList(formData, "preferredEmploymentTypes"),
    dealBreakers: commaList(formData, "dealBreakers"),
    matchingInstructions: optionalString(formData, "matchingInstructions"),
    linkedinUrl: optionalString(formData, "linkedinUrl"),
    githubUrl: optionalString(formData, "githubUrl"),
    portfolioUrl: optionalString(formData, "portfolioUrl"),
    summary: optionalString(formData, "summary"),
    firstName: optionalString(formData, "firstName"),
    lastName: optionalString(formData, "lastName"),
    phone: optionalString(formData, "phone"),
    addressLine1: optionalString(formData, "addressLine1"),
    addressLine2: optionalString(formData, "addressLine2"),
    city: optionalString(formData, "city"),
    stateRegion: optionalString(formData, "stateRegion"),
    postalCode: optionalString(formData, "postalCode"),
    country: optionalString(formData, "country") ?? "United States",
    currentCompany: optionalString(formData, "currentCompany"),
    currentTitle: optionalString(formData, "currentTitle"),
    yearsTotalExperience: yearsRaw ? Number(yearsRaw) : null,
  });

  await getDb()
    .insert(candidateProfiles)
    .values({ userId: user.id, ...input })
    .onConflictDoUpdate({
      target: candidateProfiles.userId,
      set: { ...input, updatedAt: new Date() },
    });
  revalidatePath("/profile");
}

export async function saveCommonAnswer(formData: FormData) {
  const user = await requireDashboardUser();
  const input = z
    .object({
      questionKey: z
        .string()
        .trim()
        .min(1)
        .max(150)
        .regex(/^[a-z0-9_]+$/),
      questionText: z.string().trim().min(1).max(2_000),
      answerText: z.string().trim().min(1).max(20_000),
      category: z.string().trim().min(1).max(100),
    })
    .parse({
      questionKey: requiredString(formData, "questionKey"),
      questionText: requiredString(formData, "questionText"),
      answerText: requiredString(formData, "answerText"),
      category: requiredString(formData, "category"),
    });

  await getDb()
    .insert(commonAnswers)
    .values({ userId: user.id, ...input })
    .onConflictDoUpdate({
      target: [commonAnswers.userId, commonAnswers.questionKey],
      set: {
        questionText: input.questionText,
        answerText: input.answerText,
        category: input.category,
        updatedAt: new Date(),
      },
    });
  revalidatePath("/profile");
}

/**
 * Saves one of the addresses the candidate can apply from. Marking an address primary
 * clears the flag on the others, since exactly one is the fallback for postings with no
 * usable location.
 */
export async function saveCandidateAddress(formData: FormData) {
  const user = await requireDashboardUser();
  const input = z
    .object({
      label: z.string().trim().min(1).max(60),
      line1: z.string().trim().min(1).max(200),
      line2: z.string().trim().max(200).nullable(),
      city: z.string().trim().min(1).max(100),
      stateRegion: z.string().trim().min(1).max(100),
      postalCode: z.string().trim().min(1).max(20),
      country: z.string().trim().min(1).max(100),
      isPrimary: z.boolean(),
      matchTerms: z.array(z.string().trim().min(1).max(60)).max(40),
    })
    .parse({
      label: requiredString(formData, "label"),
      line1: requiredString(formData, "line1"),
      line2: optionalString(formData, "line2"),
      city: requiredString(formData, "city"),
      stateRegion: requiredString(formData, "stateRegion"),
      postalCode: requiredString(formData, "postalCode"),
      country: requiredString(formData, "country") || "United States",
      isPrimary: formData.get("isPrimary") === "on",
      matchTerms: commaList(formData, "matchTerms").map((term) => term.toLowerCase()),
    });

  const db = getDb();
  await db
    .insert(candidateAddresses)
    .values({ userId: user.id, ...input, line2: input.line2 })
    .onConflictDoUpdate({
      target: [candidateAddresses.userId, candidateAddresses.label],
      set: {
        line1: input.line1,
        line2: input.line2,
        city: input.city,
        stateRegion: input.stateRegion,
        postalCode: input.postalCode,
        country: input.country,
        isPrimary: input.isPrimary,
        matchTerms: input.matchTerms,
        updatedAt: new Date(),
      },
    });

  if (input.isPrimary) {
    await db
      .update(candidateAddresses)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(candidateAddresses.userId, user.id),
          sql`${candidateAddresses.label} <> ${input.label}`,
        ),
      );
  }
  revalidatePath("/profile");
}

export async function deleteCandidateAddress(formData: FormData) {
  const user = await requireDashboardUser();
  const addressId = z.uuid().parse(requiredString(formData, "addressId"));
  await getDb()
    .delete(candidateAddresses)
    .where(
      and(eq(candidateAddresses.id, addressId), eq(candidateAddresses.userId, user.id)),
    );
  revalidatePath("/profile");
}

/**
 * Confirms or corrects a resume-derived fact. Saving marks it verified, which both makes
 * it usable regardless of extraction confidence and protects it from being overwritten
 * the next time the resume is re-synced.
 */
export async function saveCandidateFact(formData: FormData) {
  const user = await requireDashboardUser();
  const input = z
    .object({
      factKey: z.enum(FACT_KEYS),
      factValue: z.string().trim().min(1).max(200),
    })
    .parse({
      factKey: requiredString(formData, "factKey"),
      factValue: requiredString(formData, "factValue"),
    });

  let value = input.factValue;
  if (YEARS_FACT_KEYS.has(input.factKey)) {
    const normalized = normalizeYearsValue(value);
    if (!normalized) {
      throw new Error("Years must be a whole number between 0 and 60.");
    }
    value = normalized;
  }

  await getDb()
    .insert(candidateFacts)
    .values({
      userId: user.id,
      factKey: input.factKey,
      factValue: value,
      confidence: 100,
      evidence: "",
      source: "user",
      verified: true,
    })
    .onConflictDoUpdate({
      target: [candidateFacts.userId, candidateFacts.factKey],
      set: {
        factValue: value,
        confidence: 100,
        source: "user",
        verified: true,
        resumeVersionId: null,
        updatedAt: new Date(),
      },
    });
  revalidatePath("/profile");
}

export async function deleteCandidateFact(formData: FormData) {
  const user = await requireDashboardUser();
  const factId = z.uuid().parse(requiredString(formData, "factId"));
  await getDb()
    .delete(candidateFacts)
    .where(and(eq(candidateFacts.id, factId), eq(candidateFacts.userId, user.id)));
  revalidatePath("/profile");
}

export async function queueJobReview(jobId: string) {
  const user = await requireDashboardUser();
  const id = z.uuid().parse(jobId);
  await createCommand(
    {
      type: "review_job",
      payloadJson: { jobId: id, reviewerType: "codex" },
      priority: "high",
    },
    { source: "dashboard", requestedBy: user.id },
  );
  revalidatePath(`/jobs/${id}`);
  revalidatePath("/commands");
}

export async function queueJobReprocess(jobId: string) {
  const user = await requireDashboardUser();
  const id = z.uuid().parse(jobId);
  await createCommand(
    {
      type: "reprocess_job",
      payloadJson: { jobId: id, stages: ["normalize", "extract", "filter"] },
      priority: "normal",
    },
    { source: "dashboard", requestedBy: user.id },
  );
  revalidatePath(`/jobs/${id}`);
  revalidatePath("/commands");
}

export async function retryCommand(commandId: string) {
  const user = await requireDashboardUser();
  const id = z.uuid().parse(commandId);
  const failed = await getCommandDetail(id, user.id);
  if (!failed || failed.status !== "failed") return;
  const retried = await createCommand(
    {
      type: failed.type,
      payloadJson: failed.payloadJson,
      priority: failed.priority,
    },
    { source: "dashboard", requestedBy: user.id },
  );
  await getDb().insert(commandEvents).values({
    commandId: id,
    eventType: "retried",
    message: "A new command was created from this failed command.",
    metadataJson: { newCommandId: retried.id, requestedBy: user.id },
  });
  revalidatePath("/commands");
}

export async function cancelQueuedCommand(commandId: string) {
  const user = await requireDashboardUser();
  const id = z.uuid().parse(commandId);
  await cancelCommand(id, user.id);
  revalidatePath("/commands");
}

export async function updateFollowup(formData: FormData) {
  await requireDashboardUser();
  const id = z.uuid().parse(requiredString(formData, "followupId"));
  const input = followupUpdateSchema.parse({
    status: z
      .enum(FOLLOWUP_STATUSES)
      .parse(requiredString(formData, "status")),
    notes: optionalString(formData, "notes"),
  });
  await getDb()
    .update(followups)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(followups.id, id)));
  revalidatePath("/follow-ups");
  revalidatePath("/");
}

async function getOwnedResume(userId: string, resumeVersionId: string) {
  const [resume] = await getDb()
    .select()
    .from(resumeVersions)
    .where(
      and(eq(resumeVersions.id, resumeVersionId), eq(resumeVersions.userId, userId)),
    )
    .limit(1);
  return resume ?? null;
}

export async function createTargetRole(formData: FormData) {
  const user = await requireDashboardUser();
  const input = z
    .object({
      title: z.string().trim().min(1).max(200),
      locations: z.array(z.string().min(1).max(200)).min(1).max(20),
      resumeVersionId: z.uuid(),
      maxApplicationsPerRun: z.number().int().min(1).max(50).nullable(),
      notes: z.string().trim().max(5_000).nullable(),
      active: z.boolean(),
    })
    .parse({
      title: requiredString(formData, "title"),
      locations: commaList(formData, "locations"),
      resumeVersionId: requiredString(formData, "resumeVersionId"),
      maxApplicationsPerRun: optionalString(formData, "maxApplicationsPerRun")
        ? Number(requiredString(formData, "maxApplicationsPerRun"))
        : null,
      notes: optionalString(formData, "notes"),
      active: formData.get("active") === "on",
    });

  const resume = await getOwnedResume(user.id, input.resumeVersionId);
  if (!resume) throw new Error("Resume version not found.");
  if (input.active && !isResumeHealthyForActivation(resume)) {
    throw new Error("Cannot activate a role whose resume text is unhealthy. Re-extract or upload a clearer PDF/DOCX.");
  }

  // Deactivate first: the new row does not exist yet, so there is nothing to keep.
  if (input.active) await deactivateOtherRoles(user.id);
  await getDb().insert(targetRoles).values({
    userId: user.id,
    title: input.title,
    locations: input.locations,
    resumeVersionId: input.resumeVersionId,
    maxApplicationsPerRun: input.maxApplicationsPerRun,
    notes: input.notes,
    active: input.active,
  });
  revalidatePath("/roles");
}

/**
 * Clears the user's other active roles so exactly one stays active.
 * Must run before activating a role: target_roles_one_active_per_user rejects a second
 * active row, and it is the database, not this function, that is the real guarantee.
 */
async function deactivateOtherRoles(userId: string, keepRoleId?: string) {
  const where = keepRoleId
    ? and(
        eq(targetRoles.userId, userId),
        eq(targetRoles.active, true),
        ne(targetRoles.id, keepRoleId),
      )
    : and(eq(targetRoles.userId, userId), eq(targetRoles.active, true));
  await getDb()
    .update(targetRoles)
    .set({ active: false, updatedAt: new Date() })
    .where(where);
}

export async function updateTargetRole(formData: FormData) {
  const user = await requireDashboardUser();
  const id = z.uuid().parse(requiredString(formData, "roleId"));
  const input = z
    .object({
      title: z.string().trim().min(1).max(200),
      locations: z.array(z.string().min(1).max(200)).min(1).max(20),
      resumeVersionId: z.uuid(),
      maxApplicationsPerRun: z.number().int().min(1).max(50).nullable(),
      notes: z.string().trim().max(5_000).nullable(),
      active: z.boolean(),
    })
    .parse({
      title: requiredString(formData, "title"),
      locations: commaList(formData, "locations"),
      resumeVersionId: requiredString(formData, "resumeVersionId"),
      maxApplicationsPerRun: optionalString(formData, "maxApplicationsPerRun")
        ? Number(requiredString(formData, "maxApplicationsPerRun"))
        : null,
      notes: optionalString(formData, "notes"),
      active: formData.get("active") === "on",
    });

  const resume = await getOwnedResume(user.id, input.resumeVersionId);
  if (!resume) throw new Error("Resume version not found.");
  if (input.active && !isResumeHealthyForActivation(resume)) {
    throw new Error("Cannot activate a role whose resume text is unhealthy. Re-extract or upload a clearer PDF/DOCX.");
  }

  if (input.active) await deactivateOtherRoles(user.id, id);
  await getDb()
    .update(targetRoles)
    .set({
      title: input.title,
      locations: input.locations,
      resumeVersionId: input.resumeVersionId,
      maxApplicationsPerRun: input.maxApplicationsPerRun,
      notes: input.notes,
      active: input.active,
      updatedAt: new Date(),
    })
    .where(and(eq(targetRoles.id, id), eq(targetRoles.userId, user.id)));
  revalidatePath("/roles");
}

export async function setTargetRoleActive(roleId: string, active: boolean) {
  const user = await requireDashboardUser();
  const id = z.uuid().parse(roleId);
  const [role] = await getDb()
    .select()
    .from(targetRoles)
    .where(and(eq(targetRoles.id, id), eq(targetRoles.userId, user.id)))
    .limit(1);
  if (!role) throw new Error("Role not found.");
  if (active) {
    const resume = await getOwnedResume(user.id, role.resumeVersionId);
    if (!resume || !isResumeHealthyForActivation(resume)) {
      throw new Error("Cannot activate a role whose resume text is unhealthy.");
    }
    // Activating a role retires whichever role was active before it.
    await deactivateOtherRoles(user.id, id);
  }
  await getDb()
    .update(targetRoles)
    .set({ active, updatedAt: new Date() })
    .where(and(eq(targetRoles.id, id), eq(targetRoles.userId, user.id)));
  revalidatePath("/roles");
}

export async function queueResumeTextSync(resumeVersionId?: string) {
  const user = await requireDashboardUser();
  const payloadJson = resumeVersionId
    ? { resumeVersionIds: [z.uuid().parse(resumeVersionId)] }
    : {};
  await createCommand(
    { type: "sync_resume_text", payloadJson, priority: "normal" },
    { source: "dashboard", requestedBy: user.id },
  );
  revalidatePath("/roles");
  revalidatePath("/profile");
  revalidatePath("/commands");
}

export async function answerPendingQuestion(formData: FormData) {
  const user = await requireDashboardUser();
  const questionId = z.uuid().parse(requiredString(formData, "questionId"));
  const answer = requiredString(formData, "answer");
  const db = getDb();
  const [question] = await db
    .select()
    .from(pendingQuestions)
    .where(
      and(
        eq(pendingQuestions.id, questionId),
        eq(pendingQuestions.userId, user.id),
        eq(pendingQuestions.status, "open"),
      ),
    )
    .limit(1);
  if (!question) throw new Error("Question not found or already answered.");

  const { acceptPendingAnswer } = await import("@/services/pendingAnswers");
  const result = await acceptPendingAnswer({
    question,
    rawAnswer: answer,
    source: "dashboard",
  });
  if (!result.ok) throw new Error(result.message);
  revalidatePath("/questions");
  revalidatePath("/commands");
}

export async function dismissPendingQuestion(formData: FormData) {
  const user = await requireDashboardUser();
  const questionId = z.uuid().parse(requiredString(formData, "questionId"));
  await getDb()
    .update(pendingQuestions)
    .set({
      status: "dismissed",
      answeredBy: "dashboard",
      answeredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pendingQuestions.id, questionId),
        eq(pendingQuestions.userId, user.id),
        eq(pendingQuestions.status, "open"),
      ),
    );
  revalidatePath("/questions");
}

export async function queueApplyNow(jobId?: string) {
  const user = await requireDashboardUser();
  if (jobId) {
    await createCommand(
      {
        type: "apply_to_jobs",
        payloadJson: { jobIds: [z.uuid().parse(jobId)] },
        priority: "high",
      },
      { source: "dashboard", requestedBy: user.id },
    );
  } else {
    await createCommand(
      {
        type: "run_apply_cycle",
        payloadJson: { phase: "discover" },
        priority: "normal",
      },
      { source: "dashboard", requestedBy: user.id },
    );
  }
  revalidatePath("/applications");
  revalidatePath("/commands");
  revalidatePath("/jobs");
}

export async function setApplyPaused(paused: boolean) {
  const user = await requireDashboardUser();
  const value = z.boolean().parse(paused);
  await getDb()
    .insert(automationSettings)
    .values({ userId: user.id, applyPaused: value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: automationSettings.userId,
      set: { applyPaused: value, updatedAt: new Date() },
    });
  revalidatePath("/applications");
  revalidatePath("/");
}

export async function safeRetryApplication(applicationId: string) {
  const user = await requireDashboardUser();
  const id = z.uuid().parse(applicationId);
  const db = getDb();
  const [application] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, id), eq(applications.userId, user.id)))
    .limit(1);
  if (!application) throw new Error("Application not found.");
  const retryable = ["needs_manual", "blocked", "failed"].includes(application.status) ||
    (application.status === "filling" && application.stopReason === "filled_not_submitted");
  if (!retryable) {
    throw new Error(`Application status ${application.status} is not safe to retry.`);
  }
  const [openQuestions] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pendingQuestions)
    .where(
      and(
        eq(pendingQuestions.applicationId, application.id),
        eq(pendingQuestions.status, "open"),
      ),
    );
  if ((openQuestions?.count ?? 0) > 0) {
    throw new Error("Answer the open application questions before retrying.");
  }
  await db
    .update(applications)
    .set({ status: "ready", stopReason: "safe_retry_requested", updatedAt: new Date() })
    .where(eq(applications.id, application.id));
  await createCommand(
    {
      type: "apply_to_jobs",
      payloadJson: { jobIds: [application.jobId] },
      priority: "high",
    },
    { source: "dashboard", requestedBy: user.id },
  );
  revalidatePath("/applications");
  revalidatePath("/commands");
}

export async function reverifySubmission(applicationId: string) {
  const user = await requireDashboardUser();
  const id = z.uuid().parse(applicationId);
  const [application] = await getDb()
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.id, id),
        eq(applications.userId, user.id),
        eq(applications.status, "submission_unknown"),
      ),
    )
    .limit(1);
  if (!application) throw new Error("Unknown submission not found.");
  await createCommand(
    {
      type: "verify_submission",
      payloadJson: { applicationId: id },
      priority: "high",
    },
    { source: "dashboard", requestedBy: user.id },
  );
  revalidatePath("/applications");
  revalidatePath("/commands");
}

export async function resolveSubmissionUnknown(formData: FormData) {
  const user = await requireDashboardUser();
  const applicationId = z.uuid().parse(requiredString(formData, "applicationId"));
  const resolution = z.enum(["applied", "not_applied"]).parse(requiredString(formData, "resolution"));
  const db = getDb();
  const [application] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.userId, user.id)))
    .limit(1);
  if (!application) throw new Error("Application not found.");
  if (application.status !== "submission_unknown") {
    throw new Error("Only submission_unknown applications can be resolved this way.");
  }

  if (resolution === "applied") {
    await db.batch([
      db
        .update(applications)
        .set({
          status: "applied",
          appliedAt: new Date(),
          stopReason: "resolved_manual_applied",
          updatedAt: new Date(),
        })
        .where(eq(applications.id, applicationId)),
      db
        .update(jobs)
        .set({ status: "applied", updatedAt: new Date() })
        .where(eq(jobs.id, application.jobId)),
    ]);
  } else {
    await db
      .update(applications)
      .set({
        status: "needs_manual",
        stopReason: "resolved_manual_not_applied",
        updatedAt: new Date(),
      })
      .where(eq(applications.id, applicationId));
  }
  revalidatePath("/applications");
  revalidatePath(`/jobs/${application.jobId}`);
}
