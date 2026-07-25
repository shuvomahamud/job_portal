import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { CalendarClock, Save } from "lucide-react";
import { getDb } from "@/db";
import { applications, followups, jobs } from "@/db/schema";
import {
  EmptyState,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import { FOLLOWUP_STATUSES } from "@/lib/constants";
import { formatDateTime, humanize } from "@/lib/format";
import { updateFollowup } from "../actions";

export default async function FollowUpsPage() {
  const rows = await getDb()
    .select({
      followup: followups,
      jobTitle: jobs.title,
      company: jobs.company,
      applicationStatus: applications.status,
    })
    .from(followups)
    .innerJoin(jobs, eq(followups.jobId, jobs.id))
    .leftJoin(applications, eq(followups.applicationId, applications.id))
    .orderBy(asc(followups.dueAt));

  const dueCount = rows.filter(
    ({ followup }) =>
      followup.status === "pending" && followup.dueAt <= new Date(),
  ).length;

  return (
    <>
      <PageHeader
        eyebrow="Relationship cadence"
        title="Follow-up center"
        description={`${dueCount} follow-up${dueCount === 1 ? "" : "s"} due now. Keep notes factual and messages human-reviewed.`}
      />
      {rows.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {rows.map(({ followup, jobTitle, company, applicationStatus }) => {
            const overdue =
              followup.status === "pending" && followup.dueAt <= new Date();
            return (
              <article className="panel p-5 sm:p-6" key={followup.id}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge value={followup.status} />
                      {overdue && (
                        <StatusBadge value="due now" tone="warning" />
                      )}
                    </div>
                    <Link
                      href={`/jobs/${followup.jobId}`}
                      className="mt-4 block text-lg font-semibold tracking-[-0.025em] text-[var(--ink)] hover:text-[var(--accent-dark)]"
                    >
                      {jobTitle}
                    </Link>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {company}
                      {applicationStatus
                        ? ` · ${humanize(applicationStatus)}`
                        : ""}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-[var(--soft)] px-4 py-3 text-right">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                      Due
                    </p>
                    <p className="mt-1 text-sm font-semibold text-[var(--ink)]">
                      {formatDateTime(followup.dueAt)}
                    </p>
                  </div>
                </div>

                {followup.messageTemplate && (
                  <div className="mt-5 rounded-2xl bg-[var(--soft)] p-4">
                    <p className="eyebrow">Message notes</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--muted)]">
                      {followup.messageTemplate}
                    </p>
                  </div>
                )}

                <form action={updateFollowup} className="mt-5 grid gap-3 sm:grid-cols-[160px_1fr_auto]">
                  <input
                    type="hidden"
                    name="followupId"
                    value={followup.id}
                  />
                  <select
                    name="status"
                    defaultValue={followup.status}
                    aria-label={`Status for ${jobTitle} follow-up`}
                  >
                    {FOLLOWUP_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {humanize(status)}
                      </option>
                    ))}
                  </select>
                  <input
                    name="notes"
                    defaultValue={followup.notes ?? ""}
                    placeholder="Add an outcome or reminder"
                    aria-label={`Notes for ${jobTitle} follow-up`}
                  />
                  <button className="secondary-button">
                    <Save className="size-4" /> Save
                  </button>
                </form>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="panel">
          <EmptyState
            title="No follow-ups scheduled"
            description="Follow-ups linked to applications will be collected here in due-date order."
          />
        </section>
      )}
      <div className="mt-6 flex items-start gap-3 rounded-2xl bg-[var(--ink)] p-5 text-sm leading-6 text-white/75">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
        n8n will be able to create event records in Phase 2, but this dashboard
        remains the system of record for follow-up state.
      </div>
    </>
  );
}
