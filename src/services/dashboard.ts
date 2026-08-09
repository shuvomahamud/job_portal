import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

type SummaryRow = {
  jobs_found_today: number;
  jobs_needing_review: number;
  ready_to_apply: number;
  applied_today: number;
  applied_this_week: number;
  questions_open: number;
  needs_manual: number;
  blocked: number;
  submission_unknown: number;
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
        WHERE applied_at >= CURRENT_DATE
      ) AS applied_today,
      (
        SELECT COUNT(*)::int
        FROM applications
        WHERE applied_at >= DATE_TRUNC('week', NOW())
      ) AS applied_this_week,
      (
        SELECT COUNT(*)::int
        FROM pending_questions
        WHERE status = 'open'
      ) AS questions_open,
      (
        SELECT COUNT(*)::int
        FROM applications
        WHERE status = 'needs_manual'
      ) AS needs_manual,
      (
        SELECT COUNT(*)::int
        FROM applications
        WHERE status = 'blocked'
      ) AS blocked,
      (
        SELECT COUNT(*)::int
        FROM applications
        WHERE status = 'submission_unknown'
      ) AS submission_unknown,
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
    applied_today: 0,
    applied_this_week: 0,
    questions_open: 0,
    needs_manual: 0,
    blocked: 0,
    submission_unknown: 0,
    followups_due: 0,
    interviews_scheduled: 0,
  };

  const nextBestAction =
    summary.questions_open > 0
      ? {
          label: "Answer pending questions",
          detail: `${summary.questions_open} question${summary.questions_open === 1 ? "" : "s"} blocking apply`,
          href: "/questions",
        }
      : summary.submission_unknown > 0
        ? {
            label: "Resolve unknown submissions",
            detail: `${summary.submission_unknown} need a human decision`,
            href: "/applications?status=submission_unknown",
          }
      : summary.followups_due > 0
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
    appliedToday: summary.applied_today,
    appliedThisWeek: summary.applied_this_week,
    questionsOpen: summary.questions_open,
    needsManual: summary.needs_manual,
    blocked: summary.blocked,
    submissionUnknown: summary.submission_unknown,
    followupsDue: summary.followups_due,
    interviewsScheduled: summary.interviews_scheduled,
    nextBestAction,
  };
}
