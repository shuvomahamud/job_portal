/**
 * Summarize recent apply_to_jobs commands, application stop reasons, and open questions.
 *
 *   WORKER_ENV_FILE="$HOME/Library/Application Support/JobAgent/worker.env" npx tsx worker/scripts/inspectLastApplyRun.ts
 *
 * Prints no secrets.
 */
import { config as loadEnv } from "dotenv";
import { desc, eq, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { getScriptDb } from "../src/scriptDb";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.local", quiet: true });
loadEnv({ path: ".env.local", quiet: true });

async function main() {
  const db = getScriptDb();

  const commands = await db
    .select({
      id: schema.commands.id,
      status: schema.commands.status,
      createdAt: schema.commands.createdAt,
      completedAt: schema.commands.completedAt,
      errorMessage: schema.commands.errorMessage,
      resultJson: schema.commands.resultJson,
    })
    .from(schema.commands)
    .where(eq(schema.commands.type, "apply_to_jobs"))
    .orderBy(desc(schema.commands.createdAt))
    .limit(15);

  const stopReasonCounts = await db
    .select({
      status: schema.applications.status,
      stopReason: schema.applications.stopReason,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.applications)
    .groupBy(schema.applications.status, schema.applications.stopReason)
    .orderBy(desc(sql`count(*)`));

  const recentApplications = await db
    .select({
      id: schema.applications.id,
      jobId: schema.applications.jobId,
      status: schema.applications.status,
      stopReason: schema.applications.stopReason,
      applyUrl: schema.applications.applyUrl,
      updatedAt: schema.applications.updatedAt,
    })
    .from(schema.applications)
    .orderBy(desc(schema.applications.updatedAt))
    .limit(20);

  const openQuestions = await db
    .select({
      id: schema.pendingQuestions.id,
      jobId: schema.pendingQuestions.jobId,
      questionText: schema.pendingQuestions.questionText,
      status: schema.pendingQuestions.status,
      createdAt: schema.pendingQuestions.createdAt,
    })
    .from(schema.pendingQuestions)
    .where(eq(schema.pendingQuestions.status, "open"))
    .orderBy(desc(schema.pendingQuestions.createdAt))
    .limit(20);

  const malformedIndeed = await db
    .select({
      id: schema.jobs.id,
      title: schema.jobs.title,
      sourceUrl: schema.jobs.sourceUrl,
      status: schema.jobs.status,
    })
    .from(schema.jobs)
    .where(
      sql`${schema.jobs.source} = 'indeed' AND (
        ${schema.jobs.sourceUrl} ILIKE '%/addlLoc/redirect%'
        OR ${schema.jobs.title} ~* 'jobs\\s+[–-]\\s+apply today'
      )`,
    )
    .limit(50);

  const stuckFilling = await db
    .select({
      id: schema.applications.id,
      jobId: schema.applications.jobId,
      status: schema.applications.status,
      stopReason: schema.applications.stopReason,
      updatedAt: schema.applications.updatedAt,
    })
    .from(schema.applications)
    .where(sql`${schema.applications.status} IN ('draft', 'filling', 'submitting')`)
    .orderBy(desc(schema.applications.updatedAt))
    .limit(20);

  return {
    commands: commands.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      errorMessage: row.errorMessage,
      resultJson: row.resultJson,
    })),
    stopReasonCounts,
    recentApplications,
    openQuestions: openQuestions.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      questionText: row.questionText.slice(0, 160),
      status: row.status,
      createdAt: row.createdAt,
    })),
    malformedIndeedCount: malformedIndeed.length,
    malformedIndeed: malformedIndeed.map((row) => ({
      id: row.id,
      title: row.title,
      sourceUrl: row.sourceUrl,
      status: row.status,
    })),
    stuckFilling,
  };
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
