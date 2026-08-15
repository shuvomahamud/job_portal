/**
 * Archive malformed Indeed discovery rows, collapse duplicate Indeed `jk` listings, and
 * recover applications left in draft/filling/submitting — but only when their command is
 * failed, canceled, completed, missing, or stale.
 *
 * Defaults to dry-run. Pass `--apply` to write.
 *
 *   WORKER_ENV_FILE="$HOME/Library/Application Support/JobAgent/worker.env" npx tsx worker/scripts/cleanupMalformedIndeedJobs.ts
 *   WORKER_ENV_FILE="$HOME/Library/Application Support/JobAgent/worker.env" npx tsx worker/scripts/cleanupMalformedIndeedJobs.ts --apply
 *
 * Prints no secrets.
 */
import { config as loadEnv } from "dotenv";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { canonicalizeIndeedSourceUrl, indeedJobKey, isRewritableIndeedJobUrl } from "../src/search/browserDiscovery";
import { getScriptDb } from "../src/scriptDb";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.local", quiet: true });
loadEnv({ path: ".env.local", quiet: true });

const MALFORMED_STOP_REASON =
  "malformed_indeed_discovery_url: /addlLoc/redirect or search-page title, not a posting";
const STUCK_STOP_REASON = "worker_stopped_before_submit";
const DUPLICATE_STOP_REASON = "duplicate_indeed_jk";
/** Matches the worker's stale-claim window: four missed heartbeats at the default 120s. */
const STALE_COMMAND_MS = 8 * 60 * 1000;

type StuckRow = {
  id: string;
  status: string;
  jobId: string;
  workerCommandId: string | null;
  commandStatus: string | null;
  heartbeatAt: Date | null;
  claimedAt: Date | null;
};

export function isRecoverableStuckApplication(row: StuckRow, now = Date.now()): boolean {
  if (!row.workerCommandId || !row.commandStatus) return true;
  if (row.commandStatus === "failed" || row.commandStatus === "canceled" || row.commandStatus === "completed") {
    return true;
  }
  if (row.commandStatus === "claimed" || row.commandStatus === "pending") {
    const beat = row.heartbeatAt ?? row.claimedAt;
    if (!beat) return true;
    return now - beat.getTime() >= STALE_COMMAND_MS;
  }
  return false;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getScriptDb();
  const now = new Date();

  const malformedJobs = await db
    .select({
      id: schema.jobs.id,
      title: schema.jobs.title,
      sourceUrl: schema.jobs.sourceUrl,
      status: schema.jobs.status,
    })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.source, "indeed"),
        or(
          sql`${schema.jobs.sourceUrl} ILIKE '%/addlLoc/redirect%'`,
          sql`${schema.jobs.title} ~* 'jobs\\s+[–-]\\s+apply today'`,
        ),
      ),
    );

  const malformedIds = malformedJobs.map((job) => job.id);
  const unarchivedMalformedIds = malformedJobs.filter((job) => job.status !== "archived").map((job) => job.id);

  const matchRows = malformedIds.length
    ? await db
        .select({ id: schema.jobRoleMatches.id })
        .from(schema.jobRoleMatches)
        .where(
          and(
            inArray(schema.jobRoleMatches.jobId, malformedIds),
            eq(schema.jobRoleMatches.status, "match"),
          ),
        )
    : [];

  const openQuestions = malformedIds.length
    ? await db
        .select({ id: schema.pendingQuestions.id })
        .from(schema.pendingQuestions)
        .where(
          and(
            inArray(schema.pendingQuestions.jobId, malformedIds),
            eq(schema.pendingQuestions.status, "open"),
          ),
        )
    : [];

  const taggableApplications = malformedIds.length
    ? await db
        .select({ id: schema.applications.id })
        .from(schema.applications)
        .where(
          and(
            inArray(schema.applications.jobId, malformedIds),
            sql`${schema.applications.status} NOT IN ('applied', 'screening', 'interview', 'offer')`,
          ),
        )
    : [];

  const stuck = await db
    .select({
      id: schema.applications.id,
      status: schema.applications.status,
      jobId: schema.applications.jobId,
      workerCommandId: schema.applications.workerCommandId,
      commandStatus: schema.commands.status,
      heartbeatAt: schema.commands.heartbeatAt,
      claimedAt: schema.commands.claimedAt,
    })
    .from(schema.applications)
    .leftJoin(schema.commands, eq(schema.applications.workerCommandId, schema.commands.id))
    .where(inArray(schema.applications.status, ["draft", "filling", "submitting"]));

  const recoverable = stuck.filter((row) => isRecoverableStuckApplication(row));
  const skippedLive = stuck.length - recoverable.length;

  const indeedJobs = await db
    .select({
      id: schema.jobs.id,
      title: schema.jobs.title,
      sourceUrl: schema.jobs.sourceUrl,
      status: schema.jobs.status,
      createdAt: schema.jobs.createdAt,
    })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.source, "indeed"), sql`${schema.jobs.status} <> 'archived'`));

  const applicationJobIds = new Set(
    (
      await db
        .select({ jobId: schema.applications.jobId })
        .from(schema.applications)
    ).map((row) => row.jobId),
  );

  const byJk = new Map<string, typeof indeedJobs>();
  for (const job of indeedJobs) {
    const jk = indeedJobKey(job.sourceUrl);
    if (!jk) continue;
    const group = byJk.get(jk) ?? [];
    group.push(job);
    byJk.set(jk, group);
  }

  const duplicateGroups = [...byJk.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([jk, group]) => {
      const canonical = canonicalizeIndeedSourceUrl(group[0]!.sourceUrl);
      const withApplication = group.find((job) => applicationJobIds.has(job.id));
      const canonicalRow = canonical ? group.find((job) => job.sourceUrl === canonical) : undefined;
      const keeper =
        withApplication ??
        canonicalRow ??
        [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
      const extras = group.filter((job) => job.id !== keeper.id);
      return {
        jk,
        keeperId: keeper.id,
        keeperUrl: keeper.sourceUrl,
        canonicalUrl: canonical,
        extraIds: extras.map((job) => job.id),
        extraCount: extras.length,
      };
    });

  const duplicateJobIds = new Set(
    duplicateGroups.flatMap((group) => [group.keeperId, ...group.extraIds]),
  );
  const occupiedUrls = new Set(
    (
      await db
        .select({ sourceUrl: schema.jobs.sourceUrl })
        .from(schema.jobs)
    ).map((row) => row.sourceUrl),
  );
  const rewriteCandidates = indeedJobs
    // Duplicate groups are handled above so an extra row cannot claim the canonical URL
    // before the selected keeper. This pass is only for true singleton postings.
    .filter((job) => !duplicateJobIds.has(job.id))
    .filter((job) => isRewritableIndeedJobUrl(job.sourceUrl))
    .map((job) => ({
      id: job.id,
      sourceUrl: job.sourceUrl,
      canonicalUrl: canonicalizeIndeedSourceUrl(job.sourceUrl)!,
    }))
    .filter((job) => !occupiedUrls.has(job.canonicalUrl));
  const rewriteBlockedByUnique = indeedJobs.filter((job) => {
    if (duplicateJobIds.has(job.id)) return false;
    if (!isRewritableIndeedJobUrl(job.sourceUrl)) return false;
    const canonical = canonicalizeIndeedSourceUrl(job.sourceUrl);
    return canonical !== null && occupiedUrls.has(canonical);
  }).length;

  let archivedJobs = 0;
  let rejectedMatches = 0;
  let dismissedQuestions = 0;
  let taggedApplications = 0;
  let unstuckDraftOrFilling = 0;
  let recoveredSubmitting = 0;
  let archivedDuplicateJobs = 0;
  let canonicalizedKeepers = 0;
  let canonicalizedSingletons = 0;

  if (apply) {
    if (unarchivedMalformedIds.length) {
      archivedJobs = (
        await db
          .update(schema.jobs)
          .set({ status: "archived", updatedAt: now })
          .where(inArray(schema.jobs.id, unarchivedMalformedIds))
          .returning({ id: schema.jobs.id })
      ).length;
    }

    if (malformedIds.length) {
      rejectedMatches = (
        await db
          .update(schema.jobRoleMatches)
          .set({
            status: "reject",
            reasons: sql`array_append(${schema.jobRoleMatches.reasons}, ${MALFORMED_STOP_REASON})`,
            updatedAt: now,
          })
          .where(
            and(
              inArray(schema.jobRoleMatches.jobId, malformedIds),
              eq(schema.jobRoleMatches.status, "match"),
            ),
          )
          .returning({ id: schema.jobRoleMatches.id })
      ).length;

      dismissedQuestions = (
        await db
          .update(schema.pendingQuestions)
          .set({ status: "dismissed", updatedAt: now })
          .where(
            and(
              inArray(schema.pendingQuestions.jobId, malformedIds),
              eq(schema.pendingQuestions.status, "open"),
            ),
          )
          .returning({ id: schema.pendingQuestions.id })
      ).length;

      taggedApplications = (
        await db
          .update(schema.applications)
          .set({
            stopReason: MALFORMED_STOP_REASON,
            updatedAt: now,
          })
          .where(
            and(
              inArray(schema.applications.jobId, malformedIds),
              sql`${schema.applications.status} NOT IN ('applied', 'screening', 'interview', 'offer')`,
            ),
          )
          .returning({ id: schema.applications.id })
      ).length;
    }

    const recoverFilling = recoverable.filter((row) => row.status === "draft" || row.status === "filling");
    const recoverSubmitting = recoverable.filter((row) => row.status === "submitting");
    if (recoverFilling.length) {
      unstuckDraftOrFilling = (
        await db
          .update(schema.applications)
          .set({
            status: "needs_manual",
            stopReason: sql`coalesce(nullif(${schema.applications.stopReason}, ''), ${STUCK_STOP_REASON})`,
            updatedAt: now,
          })
          .where(inArray(schema.applications.id, recoverFilling.map((row) => row.id)))
          .returning({ id: schema.applications.id })
      ).length;
    }
    if (recoverSubmitting.length) {
      recoveredSubmitting = (
        await db
          .update(schema.applications)
          .set({
            status: "submission_unknown",
            stopReason: sql`coalesce(nullif(${schema.applications.stopReason}, ''), 'worker_stopped_during_submit')`,
            updatedAt: now,
          })
          .where(inArray(schema.applications.id, recoverSubmitting.map((row) => row.id)))
          .returning({ id: schema.applications.id })
      ).length;
    }

    for (const group of duplicateGroups) {
      if (group.extraIds.length) {
        archivedDuplicateJobs += (
          await db
            .update(schema.jobs)
            .set({ status: "archived", notes: DUPLICATE_STOP_REASON, updatedAt: now })
            .where(inArray(schema.jobs.id, group.extraIds))
            .returning({ id: schema.jobs.id })
        ).length;

        await db
          .update(schema.jobRoleMatches)
          .set({
            status: "reject",
            reasons: sql`array_append(${schema.jobRoleMatches.reasons}, ${DUPLICATE_STOP_REASON})`,
            updatedAt: now,
          })
          .where(
            and(
              inArray(schema.jobRoleMatches.jobId, group.extraIds),
              eq(schema.jobRoleMatches.status, "match"),
            ),
          );
      }

      if (group.canonicalUrl && group.keeperUrl !== group.canonicalUrl) {
        const [collision] = await db
          .select({ id: schema.jobs.id })
          .from(schema.jobs)
          .where(eq(schema.jobs.sourceUrl, group.canonicalUrl))
          .limit(1);
        if (!collision) {
          await db
            .update(schema.jobs)
            .set({ sourceUrl: group.canonicalUrl, updatedAt: now })
            .where(eq(schema.jobs.id, group.keeperId));
          canonicalizedKeepers += 1;
        }
      }
    }

    for (const job of rewriteCandidates) {
      if (occupiedUrls.has(job.canonicalUrl)) continue;
      await db
        .update(schema.jobs)
        .set({ sourceUrl: job.canonicalUrl, updatedAt: now })
        .where(eq(schema.jobs.id, job.id));
      occupiedUrls.delete(job.sourceUrl);
      occupiedUrls.add(job.canonicalUrl);
      canonicalizedSingletons += 1;
    }
  }

  const remainingMalformed = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.source, "indeed"),
        or(
          sql`${schema.jobs.sourceUrl} ILIKE '%/addlLoc/redirect%'`,
          sql`${schema.jobs.title} ~* 'jobs\\s+[–-]\\s+apply today'`,
        ),
        sql`${schema.jobs.status} <> 'archived'`,
      ),
    );

  return {
    dryRun: !apply,
    malformedFound: malformedJobs.length,
    wouldArchiveMalformed: unarchivedMalformedIds.length,
    wouldRejectMatches: matchRows.length,
    wouldDismissQuestions: openQuestions.length,
    wouldTagApplications: taggableApplications.length,
    stuckLiveSkipped: skippedLive,
    wouldRecoverDraftOrFilling: recoverable.filter((row) => row.status !== "submitting").length,
    wouldRecoverSubmitting: recoverable.filter((row) => row.status === "submitting").length,
    duplicateJkGroups: duplicateGroups.length,
    wouldArchiveDuplicateJobs: duplicateGroups.reduce((sum, group) => sum + group.extraCount, 0),
    sampleDuplicateJks: duplicateGroups.slice(0, 8).map((group) => ({
      jk: group.jk,
      extraCount: group.extraCount,
      canonicalUrl: group.canonicalUrl,
    })),
    archivedJobs,
    rejectedMatches,
    dismissedQuestions,
    taggedApplications,
    unstuckDraftOrFilling,
    recoveredSubmitting,
    archivedDuplicateJobs,
    canonicalizedKeepers,
    wouldCanonicalizeSingletons: rewriteCandidates.length,
    rewriteBlockedByUnique,
    canonicalizedSingletons,
    remainingUnarchivedMalformed: remainingMalformed[0]?.count ?? 0,
    hint: apply ? undefined : "Re-run with --apply to write these changes.",
  };
}

function invokedAsCli() {
  const arg = process.argv[1]?.replaceAll("\\", "/");
  return Boolean(arg?.endsWith("worker/scripts/cleanupMalformedIndeedJobs.ts"));
}

if (invokedAsCli()) {
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
}
