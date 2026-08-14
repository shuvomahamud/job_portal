import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  applications,
  automationSettings,
  commandEvents,
  commands,
  jobRoleMatches,
  jobs,
  pendingQuestions,
  resumeVersions,
  targetRoles,
} from "@/db/schema";
import { ApplyCycleControl } from "@/components/apply-cycle-control";
import { EmptyState, PageHeader, SectionHeading, StatusBadge } from "@/components/ui";
import { getApplyCycleStatus } from "@/services/applyCycle";
import { requireDashboardUser } from "@/lib/auth";
import { formatDate, formatDateTime } from "@/lib/format";
import { MAX_APPLICATIONS_PER_RUN } from "@/lib/runLimits";
import {
  reverifySubmission,
  resolveSubmissionUnknown,
  safeRetryApplication,
  setApplyPaused,
  setTargetRoleActive,
} from "../actions";

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; roleId?: string }>;
}) {
  const user = await requireDashboardUser();
  const params = await searchParams;
  const db = getDb();

  const cycleStatus = await getApplyCycleStatus(user.id);

  const conditions = [eq(applications.userId, user.id)];
  if (params.status) conditions.push(eq(applications.status, params.status as typeof applications.$inferSelect.status));
  if (params.roleId) conditions.push(eq(applications.targetRoleId, params.roleId));

  const rows = await db
    .select({
      application: applications,
      jobTitle: jobs.title,
      company: jobs.company,
      jobSource: jobs.source,
      roleTitle: targetRoles.title,
      matchScore: jobRoleMatches.score,
      resumeName: resumeVersions.originalFilename,
    })
    .from(applications)
    .leftJoin(jobs, eq(jobs.id, applications.jobId))
    .leftJoin(targetRoles, eq(targetRoles.id, applications.targetRoleId))
    .leftJoin(jobRoleMatches, eq(jobRoleMatches.id, applications.jobRoleMatchId))
    .leftJoin(resumeVersions, eq(resumeVersions.id, applications.resumeVersionId))
    .where(and(...conditions))
    .orderBy(desc(applications.updatedAt))
    .limit(100);

  const roles = await db
    .select()
    .from(targetRoles)
    .where(eq(targetRoles.userId, user.id))
    .orderBy(desc(targetRoles.active));

  const openQuestions = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pendingQuestions)
    .where(and(eq(pendingQuestions.userId, user.id), eq(pendingQuestions.status, "open")));

  const [settings] = await db
    .select({ applyPaused: automationSettings.applyPaused })
    .from(automationSettings)
    .where(eq(automationSettings.userId, user.id))
    .limit(1);
  const applyPaused = settings?.applyPaused ?? false;

  const jobIds = rows.map((row) => row.application.jobId);
  const events = jobIds.length
    ? await db
        .select({
          jobId: sql<string>`${commandEvents.metadataJson}->>'jobId'`,
          eventType: commandEvents.eventType,
          message: commandEvents.message,
          metadataJson: commandEvents.metadataJson,
          createdAt: commandEvents.createdAt,
        })
        .from(commandEvents)
        .innerJoin(commands, eq(commands.id, commandEvents.commandId))
        .where(
          and(
            eq(commands.requestedBy, user.id),
            inArray(sql<string>`${commandEvents.metadataJson}->>'jobId'`, jobIds),
          ),
        )
        .orderBy(desc(commandEvents.createdAt))
    : [];
  const eventsByJob = new Map<string, typeof events>();
  for (const event of events) {
    const current = eventsByJob.get(event.jobId) ?? [];
    current.push(event);
    eventsByJob.set(event.jobId, current);
  }

  return (
    <>
      <PageHeader
        eyebrow="Command center"
        title="Applications"
        description="Live apply pipeline status, stop reasons, and controls. Artifacts stay on the Mac disk."
      />

      <ApplyCycleControl
        initial={cycleStatus}
        initialMaxJobs={Math.min(
          MAX_APPLICATIONS_PER_RUN,
          Math.max(1, roles.find((role) => role.active)?.maxApplicationsPerRun ?? 20),
        )}
      />

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="panel p-4">
          <p className="text-sm text-[var(--muted)]">Open questions</p>
          <p className="mt-2 text-2xl font-semibold">{openQuestions[0]?.count ?? 0}</p>
        </div>
        <div className="panel p-4">
          <p className="text-sm text-[var(--muted)]">Shown</p>
          <p className="mt-2 text-2xl font-semibold">{rows.length}</p>
        </div>
      </section>

      <section className="panel mb-6 p-5 sm:p-7">
        <SectionHeading
          title="Global apply control"
          description="Pause all searching, scoring and applying for your account."
        />
        <form action={setApplyPaused.bind(null, !applyPaused)}>
          <button className={applyPaused ? "primary-button" : "secondary-button"} type="submit">
            {applyPaused ? "Resume automated apply" : "Pause automated apply"}
          </button>
          <span className="ml-3 text-sm text-[var(--muted)]">
            Currently {applyPaused ? "paused" : "running when enabled on the worker"}
          </span>
        </form>
      </section>

      <section className="panel mb-6 p-5 sm:p-7">
        <SectionHeading
          title="Per-role enable"
          description="Pause a role without deleting it. Per-run limits are edited on /roles."
        />
        <div className="space-y-3">
          {roles.map((role) => (
            <form
              key={role.id}
              action={setTargetRoleActive.bind(null, role.id, !role.active)}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] px-3 py-2"
            >
              <div>
                <p className="font-medium">{role.title}</p>
                <p className="text-xs text-[var(--muted)]">
                  {role.maxApplicationsPerRun == null
                    ? "Uses the global run limit"
                    : `Limit ${role.maxApplicationsPerRun}/run`} · {role.active ? "active" : "paused"}
                </p>
              </div>
              <button type="submit" className="secondary-button">
                {role.active ? "Pause" : "Enable"}
              </button>
            </form>
          ))}
        </div>
      </section>

      <section className="panel p-5 sm:p-7">
        <SectionHeading title="Application timeline" description="Newest updates first." />
        <form method="get" className="mb-5 flex flex-wrap gap-3">
          <select name="status" defaultValue={params.status ?? ""} className="input-field">
            <option value="">All statuses</option>
            {["draft", "filling", "awaiting_answer", "submitting", "submission_unknown", "applied", "needs_manual", "blocked", "failed"].map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
          <select name="roleId" defaultValue={params.roleId ?? ""} className="input-field">
            <option value="">All roles</option>
            {roles.map((role) => <option key={role.id} value={role.id}>{role.title}</option>)}
          </select>
          <button className="secondary-button" type="submit">Filter</button>
        </form>
        {rows.length === 0 ? (
          <EmptyState
            title="No applications yet"
            description="Search for jobs, or use Apply now on a ready job."
          />
        ) : (
          <div className="space-y-4">
            {rows.map(({ application, jobTitle, company, jobSource, roleTitle, matchScore, resumeName }) => {
              const auditEvents = eventsByJob.get(application.jobId) ?? [];
              const artifactPaths = auditEvents.flatMap((event) => {
                const artifacts = event.metadataJson?.artifacts;
                return Array.isArray(artifacts)
                  ? artifacts.filter((path): path is string => typeof path === "string")
                  : [];
              });
              const retryable = ["needs_manual", "blocked", "failed"].includes(application.status) ||
                (application.status === "filling" && application.stopReason === "filled_not_submitted");
              return (
              <article
                key={application.id}
                className="rounded-2xl border border-[var(--line)] bg-white/70 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-[var(--muted)]">
                      {company ?? "Company"} · {roleTitle ?? "Role"}
                    </p>
                    {jobSource ? (
                      <span className="source-chip mt-1 inline-block capitalize">{jobSource}</span>
                    ) : null}
                    <h3 className="mt-1 text-base font-semibold">{jobTitle ?? "Job"}</h3>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <StatusBadge value={application.status} />
                      {application.stopReason ? (
                        <StatusBadge value={application.stopReason} tone="warning" />
                      ) : null}
                    </div>
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    Updated {formatDateTime(application.updatedAt)}
                  </p>
                </div>
                <p className="mt-3 text-sm text-[var(--muted)]">
                  Applied {application.appliedAt ? formatDate(application.appliedAt) : "—"} · Resume{" "}
                  {resumeName ?? application.resumeVersionId?.slice(0, 8) ?? "—"} · Match score {matchScore ?? "—"}
                </p>
                {application.confirmationEvidence && Object.keys(application.confirmationEvidence).length ? (
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    Confirmation: {JSON.stringify(application.confirmationEvidence)}
                  </p>
                ) : null}
                {artifactPaths.length ? (
                  <details className="mt-3 text-xs text-[var(--muted)]">
                    <summary className="cursor-pointer font-medium">Artifacts ({artifactPaths.length})</summary>
                    <ul className="mt-2 space-y-1 font-mono">
                      {[...new Set(artifactPaths)].map((path) => <li className="break-all" key={path}>{path}</li>)}
                    </ul>
                  </details>
                ) : null}
                {auditEvents.length ? (
                  <details className="mt-3 text-xs text-[var(--muted)]">
                    <summary className="cursor-pointer font-medium">Audit timeline ({auditEvents.length})</summary>
                    <ol className="mt-2 space-y-2">
                      {auditEvents.map((event, index) => (
                        <li key={`${event.createdAt.toISOString()}-${index}`}>
                          {formatDateTime(event.createdAt)} · {event.eventType} · {event.message}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                {retryable ? (
                  <form className="mt-3" action={safeRetryApplication.bind(null, application.id)}>
                    <button className="secondary-button" type="submit">Safe retry</button>
                  </form>
                ) : null}
                {application.status === "submission_unknown" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <form action={resolveSubmissionUnknown}>
                      <input type="hidden" name="applicationId" value={application.id} />
                      <input type="hidden" name="resolution" value="applied" />
                      <button className="primary-button" type="submit">
                        Mark applied
                      </button>
                    </form>
                    <form action={resolveSubmissionUnknown}>
                      <input type="hidden" name="applicationId" value={application.id} />
                      <input type="hidden" name="resolution" value="not_applied" />
                      <button className="secondary-button" type="submit">
                        Mark not applied
                      </button>
                    </form>
                    <form action={reverifySubmission.bind(null, application.id)}>
                      <button className="secondary-button" type="submit">
                        Re-verify
                      </button>
                    </form>
                  </div>
                ) : null}
              </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
