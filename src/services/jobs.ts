import "server-only";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
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
  jobRoleMatches,
  jobs,
} from "@/db/schema";
import type { z } from "zod";
import type {
  jobImportSchema,
  jobsQuerySchema,
  jobUpdateSchema,
} from "@/lib/validation";
import { isPerUserJobStatus } from "@/lib/constants";

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

function buildJobFilterConditions(
  query: z.infer<typeof jobsQuerySchema>,
  userId?: string,
) {
  const conditions: SQL[] = [];
  // The AI score lives on job_role_matches, not jobs.fit_score, which stays null for
  // anything discovery found. Filter on whichever score exists for this user.
  if (query.minScore !== undefined && userId) {
    conditions.push(
      sql`COALESCE(
        (SELECT max(${jobRoleMatches.score}) FROM ${jobRoleMatches}
         WHERE ${jobRoleMatches.jobId} = ${jobs.id} AND ${jobRoleMatches.userId} = ${userId}),
        ${jobs.fitScore}
      ) >= ${query.minScore}`,
    );
  }
  if (query.status) {
    // An outcome status is a fact about this user's application, not about the posting,
    // so resolve it through applications rather than the shared jobs.status column.
    if (isPerUserJobStatus(query.status) && userId) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${applications}
          WHERE ${applications.jobId} = ${jobs.id}
            AND ${applications.userId} = ${userId}
            AND ${applications.status} = ${query.status}
        )`,
      );
    } else {
      conditions.push(eq(jobs.status, query.status));
    }
  }
  if (query.source) conditions.push(eq(jobs.source, query.source));
  if (query.company) conditions.push(ilike(jobs.company, `%${query.company}%`));
  if (query.minScore !== undefined && !userId) {
    // No user context (bulk delete by filter): fall back to the stored fit score.
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
    // Only postings the hard filter threw out are hidden. "reviewing" is what discovery
    // assigns to everything it finds, so excluding it made a whole run invisible.
    conditions.push(notInArray(jobs.status, ["archived"]));
  }
  return conditions;
}

/**
 * Jobs plus, for this user, the AI verdict and whether an application exists.
 *
 * Both live in other tables — `jobs` is shared across users and carries neither — so
 * without this join the board can show a discovered posting but not its score, and cannot
 * show that it was applied to.
 */
export async function listJobs(
  query: z.infer<typeof jobsQuerySchema>,
  userId?: string,
) {
  const conditions = buildJobFilterConditions(query, userId);
  const db = getDb();

  const rows = await db
    .select()
    .from(jobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(jobs.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  if (!userId || !rows.length) {
    return rows.map((job) => ({
      ...job,
      matchScore: null as number | null,
      matchStatus: null as string | null,
      applicationStatus: null as string | null,
      appliedAt: null as Date | null,
    }));
  }

  const ids = rows.map((job) => job.id);
  const [matchRows, applicationRows] = await Promise.all([
    db
      .select({
        jobId: jobRoleMatches.jobId,
        score: jobRoleMatches.score,
        status: jobRoleMatches.status,
      })
      .from(jobRoleMatches)
      .where(and(eq(jobRoleMatches.userId, userId), inArray(jobRoleMatches.jobId, ids))),
    db
      .select({
        jobId: applications.jobId,
        status: applications.status,
        appliedAt: applications.appliedAt,
      })
      .from(applications)
      .where(and(eq(applications.userId, userId), inArray(applications.jobId, ids))),
  ]);

  // Keep the strongest verdict when a job matched more than one role.
  const matchByJob = new Map<string, { score: number | null; status: string }>();
  for (const row of matchRows) {
    const current = matchByJob.get(row.jobId);
    if (!current || (row.score ?? -1) > (current.score ?? -1)) {
      matchByJob.set(row.jobId, { score: row.score, status: row.status });
    }
  }
  const applicationByJob = new Map(applicationRows.map((row) => [row.jobId, row]));

  return rows.map((job) => {
    const match = matchByJob.get(job.id);
    const application = applicationByJob.get(job.id);
    return {
      ...job,
      matchScore: match?.score ?? job.fitScore ?? null,
      matchStatus: match?.status ?? null,
      applicationStatus: application?.status ?? null,
      appliedAt: application?.appliedAt ?? null,
    };
  });
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
  userId?: string,
) {
  const conditions = buildJobFilterConditions(query, userId);
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
