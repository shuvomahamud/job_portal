import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { applications, commands, jobs, pendingQuestions } from "@/db/schema";

/** Command types that belong to one apply cycle, from discovery through submission. */
const CYCLE_TYPES = [
  "run_apply_cycle",
  "find_matching_jobs",
  "run_local_llm_extraction",
  "apply_to_jobs",
] as const;

const IN_FLIGHT = ["pending", "claimed"] as const;

export type ApplyCyclePhase =
  | "queued"
  | "searching"
  | "scoring"
  | "waiting"
  | "applying"
  | "failed"
  | "idle";

/** How far back a failed command still counts as "your last run". */
const FAILURE_LOOKBACK_HOURS = 24;

/** Command type names are internal; these are what the step is called on screen. */
const STEP_LABELS: Record<string, string> = {
  run_apply_cycle: "cycle",
  find_matching_jobs: "search",
  run_local_llm_extraction: "scoring",
  apply_to_jobs: "apply",
};

export type ApplyCycleStatus = {
  running: boolean;
  phase: ApplyCyclePhase;
  /** One sentence describing what is happening right now. */
  detail: string;
  startedAt: string | null;
  /** When the apply phase is scheduled to begin, if it is still waiting. */
  nextApplyAt: string | null;
  /**
   * The most recent step that failed, if any. Without this a failed command simply
   * vanishes from the in-flight query and the card reads "No apply cycle is running" —
   * indistinguishable from a run that found nothing, which is how a rejected discovery
   * payload went unnoticed for a whole run.
   */
  lastFailure: {
    step: string;
    message: string;
    failedAt: string | null;
  } | null;
  counts: {
    applied: number;
    awaitingAnswer: number;
    needsManual: number;
    blocked: number;
    failed: number;
  };
  recent: Array<{
    jobId: string;
    title: string;
    company: string;
    status: string;
    stopReason: string | null;
    updatedAt: string;
  }>;
};

/**
 * True when a cycle is already in progress for this user.
 *
 * Guards the start button: a second cycle would run its own discovery and its own apply
 * phase against the same eligible jobs, so repeated clicks turn into repeated
 * applications rather than a no-op.
 */
export async function hasApplyCycleInFlight(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: commands.id })
    .from(commands)
    .where(
      and(
        eq(commands.requestedBy, userId),
        inArray(commands.type, [...CYCLE_TYPES]),
        inArray(commands.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function getApplyCycleStatus(userId: string): Promise<ApplyCycleStatus> {
  const db = getDb();

  const failureCutoff = new Date(Date.now() - FAILURE_LOOKBACK_HOURS * 60 * 60 * 1000);

  const [active, statusRows, questionRows, recentRows, failureRows] = await Promise.all([
    db
      .select({
        id: commands.id,
        type: commands.type,
        status: commands.status,
        phase: sql<string | null>`${commands.payloadJson}->>'phase'`,
        scheduledFor: commands.scheduledFor,
        createdAt: commands.createdAt,
      })
      .from(commands)
      .where(
        and(
          eq(commands.requestedBy, userId),
          inArray(commands.type, [...CYCLE_TYPES]),
          inArray(commands.status, [...IN_FLIGHT]),
        ),
      )
      .orderBy(commands.createdAt),
    db
      .select({ status: applications.status, count: sql<number>`count(*)::int` })
      .from(applications)
      .where(eq(applications.userId, userId))
      .groupBy(applications.status),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingQuestions)
      .where(and(eq(pendingQuestions.userId, userId), eq(pendingQuestions.status, "open"))),
    db
      .select({
        jobId: applications.jobId,
        title: jobs.title,
        company: jobs.company,
        status: applications.status,
        stopReason: applications.stopReason,
        updatedAt: applications.updatedAt,
      })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(eq(applications.userId, userId))
      .orderBy(desc(applications.updatedAt))
      .limit(10),
    db
      .select({
        type: commands.type,
        errorMessage: commands.errorMessage,
        completedAt: commands.completedAt,
      })
      .from(commands)
      .where(
        and(
          eq(commands.requestedBy, userId),
          inArray(commands.type, [...CYCLE_TYPES]),
          eq(commands.status, "failed"),
          gte(commands.createdAt, failureCutoff),
        ),
      )
      .orderBy(desc(commands.createdAt))
      .limit(1),
  ]);

  const failure = failureRows[0];
  const lastFailure = failure
    ? {
        step: failure.type,
        message: failure.errorMessage ?? "The step failed without recording a reason.",
        failedAt: iso(failure.completedAt),
      }
    : null;

  const byStatus = new Map(statusRows.map((row) => [row.status, row.count]));
  const counts = {
    applied: byStatus.get("applied") ?? 0,
    awaitingAnswer: questionRows[0]?.count ?? 0,
    needsManual: byStatus.get("needs_manual") ?? 0,
    blocked: byStatus.get("blocked") ?? 0,
    failed: (byStatus.get("failed") ?? 0) + (byStatus.get("submission_unknown") ?? 0),
  };

  const recent = recentRows.map((row) => ({
    jobId: row.jobId,
    title: row.title,
    company: row.company,
    status: row.status,
    stopReason: row.stopReason,
    updatedAt: iso(row.updatedAt) ?? "",
  }));

  if (!active.length) {
    if (lastFailure) {
      return {
        running: false,
        phase: "failed",
        detail: `The last run stopped at the ${STEP_LABELS[lastFailure.step] ?? lastFailure.step} step: ${lastFailure.message}`,
        startedAt: null,
        nextApplyAt: null,
        counts,
        recent,
        lastFailure,
      };
    }
    return {
      running: false,
      phase: "idle",
      detail: "No apply cycle is running.",
      startedAt: null,
      nextApplyAt: null,
      counts,
      recent,
      lastFailure,
    };
  }

  const startedAt = iso(active[0]!.createdAt);
  const has = (type: string, status?: string) =>
    active.find((row) => row.type === type && (!status || row.status === status));

  // Ordered by how far along the pipeline the work is, so the most advanced stage wins.
  if (has("apply_to_jobs")) {
    return {
      running: true,
      phase: "applying",
      detail: "Filling and submitting applications. This is paced to human speed, so it takes a while.",
      startedAt,
      nextApplyAt: null,
      counts,
      recent,
      lastFailure,
    };
  }
  if (has("run_local_llm_extraction")) {
    return {
      running: true,
      phase: "scoring",
      detail: "Scoring the postings that were found against your resume.",
      startedAt,
      nextApplyAt: null,
      counts,
      recent,
      lastFailure,
    };
  }
  if (has("find_matching_jobs")) {
    return {
      running: true,
      phase: "searching",
      detail: "Searching Indeed and Dice for postings that fit your active role.",
      startedAt,
      nextApplyAt: null,
      counts,
      recent,
      lastFailure,
    };
  }

  const applyPhase = active.find((row) => row.type === "run_apply_cycle" && row.phase === "apply");
  if (applyPhase) {
    return {
      running: true,
      phase: "waiting",
      detail: "Discovery finished. The apply step is scheduled and will start on its own.",
      startedAt,
      nextApplyAt: iso(applyPhase.scheduledFor),
      counts,
      recent,
      lastFailure,
    };
  }

  return {
    running: true,
    phase: "queued",
    detail: "Queued. The worker picks this up on its next poll — make sure it is running.",
    startedAt,
    nextApplyAt: null,
    counts,
    recent,
    lastFailure,
  };
}
