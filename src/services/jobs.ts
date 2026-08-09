import "server-only";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb } from "@/db";
import {
  applications,
  commandEvents,
  commands,
  followups,
  jobReviews,
  jobs,
} from "@/db/schema";
import type { z } from "zod";
import type {
  jobImportSchema,
  jobsQuerySchema,
  jobUpdateSchema,
} from "@/lib/validation";

export async function importJob(input: z.infer<typeof jobImportSchema>) {
  const db = getDb();
  const [job] = await db
    .insert(jobs)
    .values({
      ...input,
      location: input.location ?? null,
      postedDate: input.postedDate ?? null,
      salaryText: input.salaryText ?? null,
      employmentType: input.employmentType ?? null,
      remoteType: input.remoteType ?? null,
      fitScore: input.fitScore ?? null,
      notes: input.notes ?? null,
    })
    .onConflictDoUpdate({
      target: jobs.sourceUrl,
      set: {
        title: input.title,
        company: input.company,
        location: input.location ?? null,
        source: input.source,
        postedDate: input.postedDate ?? null,
        description: input.description,
        salaryText: input.salaryText ?? null,
        employmentType: input.employmentType ?? null,
        remoteType: input.remoteType ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return job;
}

function buildJobFilterConditions(query: z.infer<typeof jobsQuerySchema>) {
  const conditions: SQL[] = [];
  if (query.status) conditions.push(eq(jobs.status, query.status));
  if (query.source) conditions.push(eq(jobs.source, query.source));
  if (query.company) conditions.push(ilike(jobs.company, `%${query.company}%`));
  if (query.minScore !== undefined) {
    conditions.push(gte(jobs.fitScore, query.minScore));
  }
  if (query.search) {
    const searchCondition = or(
      ilike(jobs.title, `%${query.search}%`),
      ilike(jobs.company, `%${query.search}%`),
      ilike(jobs.location, `%${query.search}%`),
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  if (query.visibility === "dashboard" && !query.status) {
    conditions.push(notInArray(jobs.status, ["new", "reviewing", "archived"]));
  }
  return conditions;
}

export async function listJobs(query: z.infer<typeof jobsQuerySchema>) {
  const conditions = buildJobFilterConditions(query);

  return getDb()
    .select()
    .from(jobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(jobs.createdAt))
    .limit(query.limit)
    .offset(query.offset);
}

export async function deleteJob(id: string) {
  const [job] = await getDb()
    .delete(jobs)
    .where(eq(jobs.id, id))
    .returning({ id: jobs.id });
  return job ?? null;
}

export async function deleteJobsMatching(
  query: z.infer<typeof jobsQuerySchema>,
) {
  const conditions = buildJobFilterConditions(query);
  if (!conditions.length) {
    throw new Error("Refusing to delete jobs without filter conditions.");
  }
  return getDb()
    .delete(jobs)
    .where(and(...conditions))
    .returning({ id: jobs.id });
}

export async function getJobDetail(id: string, userId: string) {
  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) return null;

  const [reviews, applicationRows, followupRows, applicationEvents] = await Promise.all([
    db
      .select()
      .from(jobReviews)
      .where(eq(jobReviews.jobId, id))
      .orderBy(desc(jobReviews.createdAt)),
    db
      .select()
      .from(applications)
      .where(and(eq(applications.jobId, id), eq(applications.userId, userId)))
      .orderBy(desc(applications.createdAt)),
    db
      .select()
      .from(followups)
      .innerJoin(applications, eq(applications.id, followups.applicationId))
      .where(and(eq(followups.jobId, id), eq(applications.userId, userId)))
      .orderBy(desc(followups.dueAt)),
    db
      .select({
        id: commandEvents.id,
        eventType: commandEvents.eventType,
        message: commandEvents.message,
        metadataJson: commandEvents.metadataJson,
        createdAt: commandEvents.createdAt,
      })
      .from(commandEvents)
      .innerJoin(commands, eq(commands.id, commandEvents.commandId))
      .where(
        and(
          eq(commands.requestedBy, userId),
          eq(sql<string>`${commandEvents.metadataJson}->>'jobId'`, id),
        ),
      )
      .orderBy(desc(commandEvents.createdAt)),
  ]);

  return {
    ...job,
    reviews,
    applications: applicationRows,
    followups: followupRows.map((row) => row.followups),
    applicationEvents,
  };
}

export async function updateJob(
  id: string,
  input: z.infer<typeof jobUpdateSchema>,
) {
  const [job] = await getDb()
    .update(jobs)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(jobs.id, id))
    .returning();
  return job ?? null;
}
