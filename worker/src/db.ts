import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { getConfig } from "./config";
import type { NormalizedJobInput } from "./types";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getWorkerDb() {
  if (db) return db;
  db = drizzle(neon(getConfig().DATABASE_URL), { schema });
  return db;
}

export async function upsertJobs(inputs: NormalizedJobInput[]) {
  if (!inputs.length) return [];
  const database = getWorkerDb();
  const rows = [];
  for (const input of inputs) {
    const [job] = await database
      .insert(schema.jobs)
      .values({
        title: input.title,
        company: input.company,
        location: input.location ?? null,
        source: input.source,
        sourceUrl: input.sourceUrl,
        postedDate: input.postedDate ?? null,
        description: input.description,
        salaryText: input.salaryText ?? null,
        employmentType: input.employmentType ?? null,
        remoteType: input.remoteType ?? null,
        status: input.status ?? "new",
        fitScore: input.fitScore ?? null,
        priority: input.priority ?? "normal",
        visaSignal: input.visaSignal ?? "unknown",
        techStack: input.techStack ?? [],
        notes: input.notes ?? null,
      })
      .onConflictDoUpdate({
        target: schema.jobs.sourceUrl,
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
    if (job) rows.push(job);
  }
  return rows;
}

export async function getExistingUrls(urls: string[]) {
  if (!urls.length) return new Set<string>();
  const rows = await getWorkerDb()
    .select({ sourceUrl: schema.jobs.sourceUrl })
    .from(schema.jobs)
    .where(inArray(schema.jobs.sourceUrl, urls));
  return new Set(rows.map((row) => row.sourceUrl));
}

export async function addCommandEvent(commandId: string, eventType: string, message: string, metadataJson?: Record<string, unknown>) {
  await getWorkerDb().insert(schema.commandEvents).values({ commandId, eventType, message, metadataJson });
}

export async function recoverStaleClaims(maxClaimAgeMinutes = 60) {
  const database = getWorkerDb();
  const result = await database.execute(sql`
    UPDATE commands
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = NOW(), error_message = 'Recovered from stale worker claim.'
    WHERE status = 'claimed'
      AND claimed_at < NOW() - (${maxClaimAgeMinutes} || ' minutes')::interval
    RETURNING id
  `);
  return result.rows.map((row) => String((row as { id: unknown }).id));
}

export async function getJobsForPhase2(limit = 100) {
  return getWorkerDb()
    .select()
    .from(schema.jobs)
    .where(or(eq(schema.jobs.status, "new"), isNull(schema.jobs.fitScore)))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(limit);
}
