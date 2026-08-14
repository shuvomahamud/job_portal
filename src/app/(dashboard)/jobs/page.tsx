import Link from "next/link";
import { ExternalLink, Search, SearchCheck } from "lucide-react";
import { DeleteFilteredJobsButton } from "@/components/delete-filtered-jobs-button";
import { JobDeleteButton } from "@/components/job-delete-button";
import { JobWorkflowForm } from "@/components/job-workflow-form";
import {
  EmptyState,
  PageHeader,
} from "@/components/ui";
import {
  JOB_STATUSES,
  SELECTABLE_JOB_SOURCES,
} from "@/lib/constants";
import { requireDashboardUser } from "@/lib/auth";
import { formatDate, humanize } from "@/lib/format";
import { jobsQuerySchema } from "@/lib/validation";
import { listJobs } from "@/services/jobs";
import { queueApplyNow } from "../actions";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Plain wording for the model's verdict. "uncertain" is the manual-review band, not a
 * failure — those are exactly the jobs the user is meant to decide on themselves.
 */
function verdictLabel(matchStatus: string | null): string {
  switch (matchStatus) {
    case "match":
      return "Good fit";
    case "uncertain":
      return "Your call";
    case "reject":
      return "Not a fit";
    default:
      return "Not scored";
  }
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const raw = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value,
    ]),
  );
  const parsed = jobsQuerySchema.safeParse({ ...flat, limit: 100 });
  const query = parsed.success
    ? parsed.data
    : jobsQuerySchema.parse({ limit: 100 });
  const user = await requireDashboardUser();
  const jobRows = await listJobs(query, user.id);

  return (
    <>
      <PageHeader
        eyebrow="Opportunity ledger"
        title="Jobs"
        description={`${jobRows.length} role${jobRows.length === 1 ? "" : "s"} in this view. Filter the signal, then move the best work forward.`}
        action={
          <Link href="/applications" className="primary-button">
            <SearchCheck className="size-4" /> Search jobs
          </Link>
        }
      />

      <form className="filter-bar" action="/jobs">
        <label className="filter-search">
          <Search className="size-4" />
          <input
            name="search"
            defaultValue={query.search}
            placeholder="Search title, company, location"
            aria-label="Search jobs"
          />
        </label>
        <select name="status" defaultValue={query.status ?? ""} aria-label="Status">
          <option value="">All statuses</option>
          {JOB_STATUSES.map((status) => (
            <option key={status} value={status}>
              {humanize(status)}
            </option>
          ))}
        </select>
        <select name="source" defaultValue={query.source ?? ""} aria-label="Source">
          <option value="">All sources</option>
          {SELECTABLE_JOB_SOURCES.map((source) => (
            <option key={source} value={source}>
              {humanize(source)}
            </option>
          ))}
        </select>
        <input
          name="company"
          defaultValue={query.company}
          placeholder="Company"
          aria-label="Company"
        />
        <input
          name="minScore"
          type="number"
          min={0}
          max={100}
          defaultValue={query.minScore}
          placeholder="Min score"
          aria-label="Minimum fit score"
        />
        <button className="secondary-button">Apply filters</button>
      </form>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-[var(--muted)]">
          Bulk delete removes every job matching the active filters.
        </p>
        <DeleteFilteredJobsButton
          matchCount={jobRows.length}
          query={{
            visibility: query.visibility,
            status: query.status,
            source: query.source,
            company: query.company,
            search: query.search,
            minScore: query.minScore,
          }}
        />
      </div>

      <section className="panel mt-5 overflow-hidden">
        {jobRows.length ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Source</th>
                  <th>Fit</th>
                  <th>AI verdict</th>
                  <th>Application</th>
                  <th>Workflow</th>
                  <th>Added</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {jobRows.map((job) => (
                  <tr key={job.id}>
                    <td className="min-w-[260px]">
                      <Link href={`/jobs/${job.id}`} className="table-title">
                        {job.title}
                      </Link>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {job.company} · {job.location ?? "Location not listed"}
                      </p>
                    </td>
                    <td>
                      <span className="source-chip">{humanize(job.source)}</span>
                    </td>
                    <td>
                      {job.matchScore === null ? (
                        <span className="text-xs text-[var(--muted)]">Unscored</span>
                      ) : (
                        <span className="score-pill">{job.matchScore}</span>
                      )}
                    </td>
                    <td className="min-w-[170px]">
                      <span className="source-chip">{verdictLabel(job.matchStatus)}</span>
                      {job.matchReasons.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--ink)]">
                            Why?
                          </summary>
                          <ul className="mt-1 space-y-1">
                            {job.matchReasons.map((reason, index) => (
                              <li
                                key={index}
                                className="text-xs leading-5 text-[var(--muted)]"
                              >
                                • {reason}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {job.applicationStatus ? (
                        <div>
                          <span className="source-chip">
                            {humanize(job.applicationStatus)}
                          </span>
                          {job.appliedAt && (
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              {formatDate(job.appliedAt)}
                            </p>
                          )}
                        </div>
                      ) : (
                        // The cycle only auto-applies to "match". Anything else is the
                        // user's call, so give them the button rather than a dead end.
                        <form action={queueApplyNow.bind(null, job.id)}>
                          <button type="submit" className="secondary-button">
                            Apply to this
                          </button>
                        </form>
                      )}
                    </td>
                    <td className="min-w-[250px]">
                      <JobWorkflowForm
                        jobId={job.id}
                        jobTitle={job.title}
                        status={job.status}
                        priority={job.priority}
                        compact
                      />
                    </td>
                    <td className="whitespace-nowrap text-xs text-[var(--muted)]">
                      {formatDate(job.createdAt)}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        <a
                          href={job.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="icon-button"
                          aria-label={`Open ${job.title} source`}
                        >
                          <ExternalLink className="size-4" />
                        </a>
                        <JobDeleteButton jobId={job.id} jobTitle={job.title} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No jobs match this view"
            description="Search for jobs to discover and evaluate real Indeed and Dice postings."
            href="/applications"
            action="Search jobs"
          />
        )}
      </section>
    </>
  );
}
