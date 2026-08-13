import { desc, eq } from "drizzle-orm";
import { Layers3, RefreshCw } from "lucide-react";
import { getDb } from "@/db";
import { resumeVersions, targetRoles } from "@/db/schema";
import { EmptyState, PageHeader, SectionHeading, StatusBadge } from "@/components/ui";
import { requireDashboardUser } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import {
  isResumeHealthyForActivation,
  resumeHealthLabel,
} from "@/lib/resumeHealth";
import {
  createTargetRole,
  queueResumeTextSync,
  setTargetRoleActive,
  updateTargetRole,
} from "../actions";

export default async function RolesPage() {
  const user = await requireDashboardUser();
  const db = getDb();
  const [roles, resumes] = await Promise.all([
    db
      .select()
      .from(targetRoles)
      .where(eq(targetRoles.userId, user.id))
      .orderBy(desc(targetRoles.active), desc(targetRoles.updatedAt)),
    db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.userId, user.id))
      .orderBy(desc(resumeVersions.createdAt)),
  ]);

  const resumeById = new Map(resumes.map((resume) => [resume.id, resume]));

  return (
    <>
      <PageHeader
        eyebrow="Apply configuration"
        title="Target roles"
        description="Each role pairs a job title and locations with the resume that matching and apply will use."
        action={
          <form action={queueResumeTextSync.bind(null, undefined)}>
            <button className="secondary-button">
              <RefreshCw className="size-4" /> Re-extract all pending
            </button>
          </form>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,.8fr)]">
        <section className="panel p-5 sm:p-7">
          <SectionHeading
            title="Active configuration"
            description="Unhealthy resume text blocks activation so matching never runs against empty extractions."
          />
          <div className="space-y-4">
            {roles.map((role) => {
              const resume = resumeById.get(role.resumeVersionId);
              const healthy = resume ? isResumeHealthyForActivation(resume) : false;
              return (
                <article
                  key={role.id}
                  className="rounded-2xl border border-[var(--line)] bg-white/55 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-[var(--ink)]">{role.title}</h3>
                      <p className="mt-1 text-sm text-[var(--muted)]">
                        {role.locations.join(" · ") || "No locations"}
                      </p>
                    </div>
                    <StatusBadge value={role.active ? "active" : "paused"} />
                  </div>
                  <p className="mt-3 text-sm text-[var(--muted)]">
                    Resume: {resume?.name ?? "missing"} ·{" "}
                    {resume ? resumeHealthLabel(resume) : "missing"}
                    {resume?.resumeTextChars != null
                      ? ` · ${resume.resumeTextChars} chars`
                      : ""}
                  </p>
                  {role.maxApplicationsPerRun != null ? (
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      Per-run limit: {role.maxApplicationsPerRun}
                    </p>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <form action={setTargetRoleActive.bind(null, role.id, !role.active)}>
                      <button className="secondary-button" disabled={!role.active && !healthy}>
                        {role.active ? "Deactivate" : "Activate"}
                      </button>
                    </form>
                    {resume && (
                      <form action={queueResumeTextSync.bind(null, resume.id)}>
                        <button className="secondary-button">
                          <RefreshCw className="size-4" /> Re-extract
                        </button>
                      </form>
                    )}
                  </div>
                  <details className="form-disclosure mt-4">
                    <summary>Edit role</summary>
                    <form action={updateTargetRole} className="mt-4 grid gap-4 sm:grid-cols-2">
                      <input type="hidden" name="roleId" value={role.id} />
                      <label className="field sm:col-span-2">
                        <span>Title</span>
                        <input name="title" required defaultValue={role.title} />
                      </label>
                      <label className="field sm:col-span-2">
                        <span>Locations (comma-separated)</span>
                        <input
                          name="locations"
                          required
                          defaultValue={role.locations.join(", ")}
                        />
                      </label>
                      <label className="field sm:col-span-2">
                        <span>Resume</span>
                        <select name="resumeVersionId" required defaultValue={role.resumeVersionId}>
                          {resumes.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · {resumeHealthLabel(item)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Applications per run</span>
                        <input
                          name="maxApplicationsPerRun"
                          type="number"
                          min={1}
                          max={50}
                          defaultValue={role.maxApplicationsPerRun ?? ""}
                        />
                      </label>
                      <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
                        <input name="active" type="checkbox" defaultChecked={role.active} />
                        Active
                      </label>
                      <label className="field sm:col-span-2">
                        <span>Notes</span>
                        <textarea name="notes" rows={2} defaultValue={role.notes ?? ""} />
                      </label>
                      <button className="primary-button sm:col-span-2">Save role</button>
                    </form>
                  </details>
                </article>
              );
            })}
            {!roles.length && (
              <EmptyState
                title="No target roles yet"
                description="Create a role with a healthy uploaded resume to drive discovery and apply."
              />
            )}
          </div>
        </section>

        <aside className="space-y-6">
          <section className="panel p-5 sm:p-6">
            <SectionHeading
              title="Create role"
              description="Activation requires a healthy extracted resume (≥ 800 characters, no extraction error)."
            />
            {resumes.length ? (
              <form action={createTargetRole} className="space-y-4">
                <label className="field">
                  <span>Title</span>
                  <input name="title" required placeholder="Senior .NET Developer" />
                </label>
                <label className="field">
                  <span>Locations</span>
                  <input name="locations" required placeholder="Remote, New York" />
                </label>
                <label className="field">
                  <span>Resume</span>
                  <select name="resumeVersionId" required defaultValue={resumes[0]?.id}>
                    {resumes.map((resume) => (
                      <option key={resume.id} value={resume.id}>
                        {resume.name} · {resumeHealthLabel(resume)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Applications per run</span>
                  <input name="maxApplicationsPerRun" type="number" min={1} max={50} />
                </label>
                <label className="field">
                  <span>Notes</span>
                  <textarea name="notes" rows={2} />
                </label>
                <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
                  <input name="active" type="checkbox" />
                  Activate immediately
                </label>
                <button className="primary-button w-full">
                  <Layers3 className="size-4" /> Create role
                </button>
              </form>
            ) : (
              <p className="text-sm text-[var(--muted)]">
                Upload a resume first, then create a role.
              </p>
            )}
          </section>

          <section className="panel p-5 sm:p-6">
            <SectionHeading
              title="Resumes"
              description="Stored by the JobAgent app and selectable per role."
            />
            <div className="space-y-3">
              {resumes.map((resume) => (
                <div key={resume.id} className="rounded-xl border border-[var(--line)] p-3">
                  <p className="font-medium text-[var(--ink)]">{resume.name}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {resumeHealthLabel(resume)}
                    {resume.resumeTextChars != null ? ` · ${resume.resumeTextChars} chars` : ""}
                    {" · "}
                    {formatDate(resume.createdAt)}
                  </p>
                  <form action={queueResumeTextSync.bind(null, resume.id)} className="mt-2">
                    <button className="secondary-button">Re-extract</button>
                  </form>
                </div>
              ))}
            </div>
            <p className="mt-4 rounded-xl bg-[var(--soft)] p-4 text-xs text-[var(--muted)]">
              Add resumes in the JobAgent app on your Mac.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
