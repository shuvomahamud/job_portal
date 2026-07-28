import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ExternalLink,
} from "lucide-react";
import { z } from "zod";
import { JobWorkflowForm } from "@/components/job-workflow-form";
import {
  SectionHeading,
  StatusBadge,
} from "@/components/ui";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import { getJobDetail } from "@/services/jobs";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const parsedId = z.uuid().safeParse((await params).id);
  if (!parsedId.success) notFound();
  const job = await getJobDetail(parsedId.data);
  if (!job) notFound();

  return (
    <>
      <Link href="/jobs" className="text-link mb-6 inline-flex">
        <ArrowLeft className="size-4" /> Back to jobs
      </Link>
      <header className="mb-8 flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <StatusBadge value={job.status} />
            <span className="source-chip">{humanize(job.source)}</span>
            {job.visaSignal !== "unknown" && (
              <span className="source-chip">Visa: {job.visaSignal}</span>
            )}
          </div>
          <h1 className="page-title max-w-4xl">{job.title}</h1>
          <p className="page-description">
            {job.company} · {job.location ?? "Location not listed"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={job.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="secondary-button"
          >
            Source <ExternalLink className="size-4" />
          </a>
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.7fr)]">
        <div className="space-y-6">
          <section className="panel p-5 sm:p-7">
            <SectionHeading
              title="Job description"
              description={`Captured from ${humanize(job.source)} on ${formatDate(job.createdAt)}.`}
            />
            <div className="prose-copy whitespace-pre-wrap">{job.description}</div>
          </section>

          <section className="panel p-5 sm:p-7">
            <SectionHeading
              title="Reviews"
              description="Rule, model, and human reviews appear on one audit trail."
            />
            {job.reviews.length ? (
              <div className="space-y-4">
                {job.reviews.map((review) => (
                  <article
                    key={review.id}
                    className="rounded-2xl border border-[var(--line)] bg-white/55 p-5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <StatusBadge value={review.reviewerType} tone="neutral" />
                        {review.score !== null && (
                          <span className="score-pill">{review.score}</span>
                        )}
                      </div>
                      <span className="text-xs text-[var(--muted)]">
                        {formatDateTime(review.createdAt)}
                      </span>
                    </div>
                    {review.recommendation && (
                      <p className="mt-4 font-medium text-[var(--ink)]">
                        {review.recommendation}
                      </p>
                    )}
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <ReviewList title="Strengths" items={review.strengths} />
                      <ReviewList title="Gaps" items={review.gaps} />
                    </div>
                    {review.visaNotes && (
                      <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
                        <strong className="text-[var(--ink)]">Visa: </strong>
                        {review.visaNotes}
                      </p>
                    )}
                    <ReviewProvenance rawOutput={review.rawOutput} />
                  </article>
                ))}
              </div>
            ) : (
              <p className="rounded-2xl bg-[var(--soft)] p-5 text-sm leading-6 text-[var(--muted)]">
                No AI review was recorded for this job.
              </p>
            )}
          </section>

          <section className="panel p-5 sm:p-7">
            <SectionHeading title="Application & follow-up" />
            <div className="grid gap-4 sm:grid-cols-2">
              <InfoCard
                label="Application"
                value={
                  job.applications[0]
                    ? humanize(job.applications[0].status)
                    : "Not started"
                }
                detail={
                  job.applications[0]?.applicationNotes ??
                  "No application record is linked yet."
                }
              />
              <InfoCard
                label="Next follow-up"
                value={
                  job.followups[0]
                    ? formatDateTime(job.followups[0].dueAt)
                    : "Not scheduled"
                }
                detail={
                  job.followups[0]?.notes ??
                  "A follow-up will appear here once scheduled."
                }
              />
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <section className="panel p-5 sm:p-6">
            <p className="eyebrow">Decision signals</p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Signal label="Fit score" value={job.fitScore ?? "—"} large />
              <Signal label="Priority" value={humanize(job.priority)} />
              <Signal label="Salary" value={job.salaryText ?? "Not listed"} />
              <Signal label="Work style" value={job.remoteType ?? "Not listed"} />
              <Signal
                label="Employment"
                value={job.employmentType ?? "Not listed"}
              />
              <Signal label="Posted" value={formatDate(job.postedDate)} />
            </div>
            {job.techStack.length > 0 && (
              <div className="mt-5 border-t border-[var(--line)] pt-5">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                  Stack
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {job.techStack.map((tech) => (
                    <span className="source-chip" key={tech}>
                      {tech}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="panel p-5 sm:p-6">
            <p className="eyebrow">Quick update</p>
            <JobWorkflowForm
              jobId={job.id}
              jobTitle={job.title}
              status={job.status}
              priority={job.priority}
            />
          </section>

          {job.notes && (
            <section className="panel p-5 sm:p-6">
              <p className="eyebrow">Notes</p>
              <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-[var(--muted)]">
                {job.notes}
              </p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

function ReviewProvenance({ rawOutput }: { rawOutput: unknown }) {
  if (!rawOutput || typeof rawOutput !== "object") return null;
  const metadata = rawOutput as {
    provider?: unknown;
    model?: unknown;
    promptVersion?: unknown;
    evidence?: { summary?: unknown };
    decision?: { reasons?: unknown };
  };
  const provider = typeof metadata.provider === "string" ? metadata.provider : null;
  const model = typeof metadata.model === "string" ? metadata.model : null;
  const promptVersion = typeof metadata.promptVersion === "string" ? metadata.promptVersion : null;
  const summary = typeof metadata.evidence?.summary === "string" ? metadata.evidence.summary : null;
  const reasons = Array.isArray(metadata.decision?.reasons)
    ? metadata.decision.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  if (!provider && !model && !summary && !reasons.length) return null;

  return (
    <div className="mt-4 border-t border-[var(--line)] pt-4 text-sm leading-6 text-[var(--muted)]">
      {(provider || model || promptVersion) && (
        <p>
          <strong className="text-[var(--ink)]">Reviewer: </strong>
          {[provider, model, promptVersion].filter(Boolean).join(" · ")}
        </p>
      )}
      {summary && (
        <p className="mt-2">
          <strong className="text-[var(--ink)]">Summary: </strong>
          {summary}
        </p>
      )}
      {reasons.length > 0 && <ReviewList title="Decision reasons" items={reasons} />}
    </div>
  );
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
        {title}
      </p>
      {items.length ? (
        <ul className="mt-2 space-y-2 text-sm leading-5 text-[var(--ink)]">
          {items.map((item) => (
            <li className="flex gap-2" key={item}>
              <span className="text-[var(--accent)]">•</span>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-[var(--muted)]">None recorded.</p>
      )}
    </div>
  );
}

function Signal({
  label,
  value,
  large = false,
}: {
  label: string;
  value: string | number;
  large?: boolean;
}) {
  return (
    <div className="rounded-2xl bg-[var(--soft)] p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
        {label}
      </p>
      <p
        className={`mt-2 font-semibold leading-tight text-[var(--ink)] ${large ? "text-3xl tracking-[-0.05em]" : "text-sm"}`}
      >
        {value}
      </p>
    </div>
  );
}

function InfoCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white/55 p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-3 font-semibold text-[var(--ink)]">{value}</p>
      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{detail}</p>
    </div>
  );
}
