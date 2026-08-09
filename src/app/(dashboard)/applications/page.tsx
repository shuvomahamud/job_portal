import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  applications,
  jobs,
  pendingQuestions,
  targetRoles,
} from "@/db/schema";
import { EmptyState, PageHeader, SectionHeading, StatusBadge } from "@/components/ui";
import { requireDashboardUser } from "@/lib/auth";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  queueApplyNow,
  resolveSubmissionUnknown,
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

  const conditions = [eq(applications.userId, user.id)];
  if (params.status) conditions.push(eq(applications.status, params.status as typeof applications.$inferSelect.status));
  if (params.roleId) conditions.push(eq(applications.targetRoleId, params.roleId));

  const rows = await db
    .select({
      application: applications,
      jobTitle: jobs.title,
      company: jobs.company,
      roleTitle: targetRoles.title,
    })
    .from(applications)
    .leftJoin(jobs, eq(jobs.id, applications.jobId))
    .leftJoin(targetRoles, eq(targetRoles.id, applications.targetRoleId))
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

  return (
    <>
      <PageHeader
        eyebrow="Command center"
        title="Applications"
        description="Live apply pipeline status, stop reasons, and controls. Artifacts stay on the Mac disk."
        action={
          <form action={queueApplyNow.bind(null, undefined)}>
            <button className="primary-button" type="submit">
              Run apply cycle
            </button>
          </form>
        }
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
          title="Per-role enable"
          description="Pause a role without deleting it. Daily caps are edited on /roles."
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
                  Cap {role.maxApplicationsPerDay}/day · {role.active ? "active" : "paused"}
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
        {rows.length === 0 ? (
          <EmptyState
            title="No applications yet"
            description="Queue an apply cycle or use Apply now on a ready job."
          />
        ) : (
          <div className="space-y-4">
            {rows.map(({ application, jobTitle, company, roleTitle }) => (
              <article
                key={application.id}
                className="rounded-2xl border border-[var(--line)] bg-white/70 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-[var(--muted)]">
                      {company ?? "Company"} · {roleTitle ?? "Role"}
                    </p>
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
                  {application.resumeVersionId?.slice(0, 8) ?? "—"}
                </p>
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
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
