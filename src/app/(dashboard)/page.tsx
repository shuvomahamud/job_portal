import Link from "next/link";
import { eq } from "drizzle-orm";
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarCheck2,
  CalendarClock,
  FileCheck2,
  MessageSquareText,
  SearchCheck,
  Sparkles,
} from "lucide-react";
import { MetricCard, SectionHeading, StatusBadge } from "@/components/ui";
import { FindMatchingJobsForm } from "@/components/find-matching-jobs-form";
import { MatchingRunStatus } from "@/components/matching-run-status";
import { getDb } from "@/db";
import { candidateProfiles } from "@/db/schema";
import { requireDashboardUser } from "@/lib/auth";
import { formatDate, humanize } from "@/lib/format";
import { jobsQuerySchema } from "@/lib/validation";
import { listCommands } from "@/services/commands";
import { getDashboardSummary } from "@/services/dashboard";
import { listJobs } from "@/services/jobs";

export default async function DashboardPage() {
  const user = await requireDashboardUser();
  const [summary, recentJobs, recentCommands, profiles, latestRuns] = await Promise.all([
    getDashboardSummary(),
    listJobs(jobsQuerySchema.parse({ limit: 5 })),
    listCommands({ limit: 4, requestedBy: user.id }),
    getDb().select().from(candidateProfiles).where(eq(candidateProfiles.userId, user.id)).limit(1),
    listCommands({ type: "find_matching_jobs", requestedBy: user.id, limit: 1 }),
  ]);
  const profile = profiles[0];
  const profileReady = Boolean(
    profile?.targetTitles.length &&
      profile.targetLocations.length &&
      profile.workAuthorizationAnswer?.trim() &&
      profile.sponsorshipAnswer?.trim() &&
      profile.summary?.trim() &&
      (profile.skills.length || profile.summary.trim().length >= 100),
  );

  const metrics = [
    {
      label: "Applied today",
      value: summary.appliedToday,
      icon: CalendarCheck2,
      detail: "Confirmed applications since midnight",
      accent: true,
    },
    {
      label: "Applied this week",
      value: summary.appliedThisWeek,
      icon: FileCheck2,
      detail: "Applications sent since Monday",
    },
    {
      label: "Questions awaiting",
      value: summary.questionsOpen,
      icon: MessageSquareText,
      detail: "Open pending apply questions",
    },
    {
      label: "Needs manual",
      value: summary.needsManual,
      icon: BriefcaseBusiness,
      detail: "External ATS or stalled applies",
    },
    {
      label: "Blocked",
      value: summary.blocked,
      icon: SearchCheck,
      detail: "Captcha or anti-bot stops",
    },
    {
      label: "Unknown submissions",
      value: summary.submissionUnknown,
      icon: CalendarClock,
      detail: "Resolve on /applications",
    },
  ];

  return (
    <>
      <section className="hero-panel">
        <div className="relative z-10 max-w-2xl">
          <p className="eyebrow text-[var(--accent-dark)]">Today’s focus</p>
          <h1 className="mt-3 max-w-xl text-3xl font-semibold leading-[1.08] tracking-[-0.045em] text-[var(--ink)] sm:text-5xl">
            {summary.nextBestAction.label}
          </h1>
          <p className="mt-4 text-sm leading-6 text-[var(--muted)] sm:text-base">
            {summary.nextBestAction.detail}. Keep the system decisive and every
            automated step auditable.
          </p>
          <Link
            href={summary.nextBestAction.href}
            className="primary-button mt-7"
          >
            Take next action <ArrowRight className="size-4" />
          </Link>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="hero-orbit-inner">
            <Sparkles className="size-8" />
          </div>
        </div>
      </section>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} {...metric} />
        ))}
      </div>

      <FindMatchingJobsForm
        defaults={{
          targetTitles: profile?.targetTitles ?? [],
          targetLocations: profile?.targetLocations ?? [],
          profileReady,
        }}
      />
      {latestRuns[0] && <MatchingRunStatus rootCommandId={latestRuns[0].id} />}

      <div className="mt-10 grid gap-6 xl:grid-cols-[1.55fr_.85fr]">
        <section className="panel p-5 sm:p-7">
          <SectionHeading
            title="Fresh in the pipeline"
            description="The newest roles, ranked when a score is available."
            action={
              <Link href="/jobs" className="text-link">
                All jobs <ArrowRight className="size-4" />
              </Link>
            }
          />
          <div className="divide-y divide-[var(--line)]">
            {recentJobs.map((job) => (
              <article
                key={job.id}
                className="flex flex-col gap-3 py-4 first:pt-1 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <Link
                    href={`/jobs/${job.id}`}
                    className="font-semibold tracking-[-0.015em] text-[var(--ink)] transition hover:text-[var(--accent-dark)]"
                  >
                    {job.title}
                  </Link>
                  <p className="mt-1 truncate text-sm text-[var(--muted)]">
                    {job.company} · {job.location ?? "Location not listed"} ·{" "}
                    {formatDate(job.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {job.fitScore !== null && (
                    <span className="score-pill">{job.fitScore}</span>
                  )}
                  <StatusBadge value={job.status} />
                </div>
              </article>
            ))}
            {!recentJobs.length && (
              <div className="py-12 text-center text-sm text-[var(--muted)]">
                Start a matching run to discover jobs from Indeed and Dice.
              </div>
            )}
          </div>
        </section>

        <section className="panel p-5 sm:p-7">
          <SectionHeading
            title="Command pulse"
            description="Latest work dispatched to the queue."
            action={
              <Link href="/commands" className="text-link">
                Open <ArrowRight className="size-4" />
              </Link>
            }
          />
          <div className="space-y-3">
            {recentCommands.map((command) => (
              <div
                key={command.id}
                className="rounded-2xl border border-[var(--line)] bg-white/55 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm font-semibold text-[var(--ink)]">
                    {humanize(command.type)}
                  </p>
                  <StatusBadge value={command.status} />
                </div>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  {humanize(command.source)} · {formatDate(command.createdAt)}
                </p>
              </div>
            ))}
            {!recentCommands.length && (
              <p className="py-8 text-center text-sm text-[var(--muted)]">
                No commands queued yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
