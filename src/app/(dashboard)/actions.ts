"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  applications,
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
      maxApplicationsPerDay: z.number().int().min(1).max(100).nullable(),
      notes: z.string().trim().max(5_000).nullable(),
      active: z.boolean(),
    })
    .parse({
      title: requiredString(formData, "title"),
      locations: commaList(formData, "locations"),
      resumeVersionId: requiredString(formData, "resumeVersionId"),
      maxApplicationsPerDay: optionalString(formData, "maxApplicationsPerDay")
        ? Number(requiredString(formData, "maxApplicationsPerDay"))
        : null,
      notes: optionalString(formData, "notes"),
      active: formData.get("active") === "on",
    });

  const resume = await getOwnedResume(user.id, input.resumeVersionId);
  if (!resume) throw new Error("Resume version not found.");
  if (input.active && !isResumeHealthyForActivation(resume)) {
    throw new Error("Cannot activate a role whose resume text is unhealthy. Re-extract or upload a clearer PDF/DOCX.");
  }

  await getDb().insert(targetRoles).values({
    userId: user.id,
    title: input.title,
    locations: input.locations,
    resumeVersionId: input.resumeVersionId,
    maxApplicationsPerDay: input.maxApplicationsPerDay,
    notes: input.notes,
    active: input.active,
  });
  revalidatePath("/roles");
}

export async function updateTargetRole(formData: FormData) {
  const user = await requireDashboardUser();
  const id = z.uuid().parse(requiredString(formData, "roleId"));
  const input = z
    .object({
      title: z.string().trim().min(1).max(200),
      locations: z.array(z.string().min(1).max(200)).min(1).max(20),
      resumeVersionId: z.uuid(),
      maxApplicationsPerDay: z.number().int().min(1).max(100).nullable(),
      notes: z.string().trim().max(5_000).nullable(),
      active: z.boolean(),
    })
    .parse({
      title: requiredString(formData, "title"),
      locations: commaList(formData, "locations"),
      resumeVersionId: requiredString(formData, "resumeVersionId"),
      maxApplicationsPerDay: optionalString(formData, "maxApplicationsPerDay")
        ? Number(requiredString(formData, "maxApplicationsPerDay"))
        : null,
      notes: optionalString(formData, "notes"),
      active: formData.get("active") === "on",
    });

  const resume = await getOwnedResume(user.id, input.resumeVersionId);
  if (!resume) throw new Error("Resume version not found.");
  if (input.active && !isResumeHealthyForActivation(resume)) {
    throw new Error("Cannot activate a role whose resume text is unhealthy. Re-extract or upload a clearer PDF/DOCX.");
  }

  await getDb()
    .update(targetRoles)
    .set({
      title: input.title,
      locations: input.locations,
      resumeVersionId: input.resumeVersionId,
      maxApplicationsPerDay: input.maxApplicationsPerDay,
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
