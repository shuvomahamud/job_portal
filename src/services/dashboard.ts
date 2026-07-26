import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

type SummaryRow = {
  jobs_found_today: number;
  jobs_needing_review: number;
  ready_to_apply: number;
  applied_this_week: number;
  followups_due: number;
  interviews_scheduled: number;
};

export async function getDashboardSummary() {
  const result = await getDb().execute<SummaryRow>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM jobs WHERE created_at >= CURRENT_DATE)
        AS jobs_found_today,
      (SELECT COUNT(*)::int FROM jobs WHERE status = 'needs_review')
        AS jobs_needing_review,
      (SELECT COUNT(*)::int FROM jobs WHERE status = 'ready_to_apply')
        AS ready_to_apply,
      (
        SELECT COUNT(*)::int
        FROM applications
        WHERE applied_at >= DATE_TRUNC('week', NOW())
      ) AS applied_this_week,
      (
        SELECT COUNT(*)::int
        FROM followups
        WHERE status = 'pending' AND due_at <= NOW()
      ) AS followups_due,
      (
        SELECT COUNT(*)::int
        FROM applications
        WHERE status = 'interview'
      ) AS interviews_scheduled
  `);

  const summary = result.rows[0] ?? {
    jobs_found_today: 0,
    jobs_needing_review: 0,
    ready_to_apply: 0,
    applied_this_week: 0,
    followups_due: 0,
    interviews_scheduled: 0,
  };

  const nextBestAction =
    summary.followups_due > 0
      ? {
          label: "Send due follow-ups",
          detail: `${summary.followups_due} conversation${summary.followups_due === 1 ? "" : "s"} waiting`,
          href: "/follow-ups",
        }
      : summary.ready_to_apply > 0
        ? {
            label: "Review ready applications",
            detail: `${summary.ready_to_apply} high-intent role${summary.ready_to_apply === 1 ? "" : "s"}`,
            href: "/jobs?status=ready_to_apply",
          }
        : summary.jobs_needing_review > 0
          ? {
              label: "Review the newest jobs",
              detail: `${summary.jobs_needing_review} role${summary.jobs_needing_review === 1 ? "" : "s"} need a decision`,
              href: "/jobs?status=needs_review",
            }
          : {
              label: "Find matching jobs",
              detail: "Search Indeed and Dice, then let local AI review each posting",
              href: "/",
            };

  return {
    jobsFoundToday: summary.jobs_found_today,
    jobsNeedingReview: summary.jobs_needing_review,
    readyToApply: summary.ready_to_apply,
    appliedThisWeek: summary.applied_this_week,
    followupsDue: summary.followups_due,
    interviewsScheduled: summary.interviews_scheduled,
    nextBestAction,
  };
}
