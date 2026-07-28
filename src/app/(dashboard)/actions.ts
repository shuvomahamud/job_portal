"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  candidateProfiles,
  commandEvents,
  commonAnswers,
  followups,
  resumeVersions,
} from "@/db/schema";
import { requireDashboardUser } from "@/lib/auth";
import { FOLLOWUP_STATUSES } from "@/lib/constants";
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
    targetTitles: z.array(z.string().min(1).max(200)).max(30),
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
  });
  const input = schema.parse({
    targetTitles: commaList(formData, "targetTitles"),
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

export async function addResumeVersion(formData: FormData) {
  const user = await requireDashboardUser();
  const input = z
    .object({
      name: z.string().trim().min(1).max(200),
      storagePath: z.string().trim().min(1).max(2_000),
      notes: z.string().trim().max(10_000).nullable(),
      isDefault: z.boolean(),
    })
    .parse({
      name: requiredString(formData, "name"),
      storagePath: requiredString(formData, "storagePath"),
      notes: optionalString(formData, "notes"),
      isDefault: formData.get("isDefault") === "on",
    });

  const db = getDb();
  if (input.isDefault) {
    await db
      .update(resumeVersions)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(resumeVersions.userId, user.id));
  }
  await db.insert(resumeVersions).values({ userId: user.id, ...input });
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
