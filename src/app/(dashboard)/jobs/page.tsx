import Link from "next/link";
import { ExternalLink, Search, SearchCheck } from "lucide-react";
import {
  EmptyState,
  PageHeader,
} from "@/components/ui";
import {
  JOB_STATUSES,
  PRIORITIES,
  SELECTABLE_JOB_SOURCES,
} from "@/lib/constants";
import { formatDate, humanize } from "@/lib/format";
import { jobsQuerySchema } from "@/lib/validation";
import { listJobs } from "@/services/jobs";
import { updateJobStatus } from "../actions";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

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
  const jobRows = await listJobs(query);

  return (
    <>
      <PageHeader
        eyebrow="Opportunity ledger"
        title="Jobs"
        description={`${jobRows.length} role${jobRows.length === 1 ? "" : "s"} in this view. Filter the signal, then move the best work forward.`}
        action={
          <Link href="/" className="primary-button">
            <SearchCheck className="size-4" /> Find matching jobs
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

      <section className="panel mt-5 overflow-hidden">
        {jobRows.length ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Source</th>
                  <th>Fit</th>
                  <th>Workflow</th>
                  <th>Added</th>
                  <th aria-label="Source link" />
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
                      {job.fitScore === null ? (
                        <span className="text-xs text-[var(--muted)]">Unscored</span>
                      ) : (
                        <span className="score-pill">{job.fitScore}</span>
                      )}
                    </td>
                    <td className="min-w-[250px]">
                      <form action={updateJobStatus} className="flex items-center gap-2">
                        <input type="hidden" name="jobId" value={job.id} />
                        <select
                          name="status"
                          defaultValue={job.status}
                          aria-label={`Status for ${job.title}`}
                          className="compact-select"
                        >
                          {JOB_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {humanize(status)}
                            </option>
                          ))}
                        </select>
                        <select
                          name="priority"
                          defaultValue={job.priority}
                          aria-label={`Priority for ${job.title}`}
                          className="compact-select"
                        >
                          {PRIORITIES.map((priority) => (
                            <option key={priority} value={priority}>
                              {humanize(priority)}
                            </option>
                          ))}
                        </select>
                        <button className="mini-button">Save</button>
                      </form>
                    </td>
                    <td className="whitespace-nowrap text-xs text-[var(--muted)]">
                      {formatDate(job.createdAt)}
                    </td>
                    <td>
                      <a
                        href={job.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="icon-button"
                        aria-label={`Open ${job.title} source`}
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No jobs match this view"
            description="Start a matching run from the overview to discover and evaluate real Indeed and Dice postings."
            href="/"
            action="Find matching jobs"
          />
        )}
      </section>
    </>
  );
}
