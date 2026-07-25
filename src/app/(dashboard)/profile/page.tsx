import { desc, eq } from "drizzle-orm";
import {
  BookOpenText,
  FileText,
  Link2,
  Save,
  ShieldCheck,
} from "lucide-react";
import { getDb } from "@/db";
import {
  candidateProfiles,
  commonAnswers,
  resumeVersions,
} from "@/db/schema";
import { PageHeader, SectionHeading } from "@/components/ui";
import { requireDashboardUser } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import {
  addResumeVersion,
  saveCandidateProfile,
  saveCommonAnswer,
} from "../actions";

export default async function ProfilePage() {
  const user = await requireDashboardUser();
  const db = getDb();
  const [profiles, resumes, answers] = await Promise.all([
    db
      .select()
      .from(candidateProfiles)
      .where(eq(candidateProfiles.userId, user.id))
      .limit(1),
    db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.userId, user.id))
      .orderBy(desc(resumeVersions.isDefault), desc(resumeVersions.createdAt)),
    db
      .select()
      .from(commonAnswers)
      .where(eq(commonAnswers.userId, user.id))
      .orderBy(commonAnswers.category, commonAnswers.questionKey),
  ]);
  const profile = profiles[0];

  return (
    <>
      <PageHeader
        eyebrow="Candidate source of truth"
        title="Profile hub"
        description="Keep stable facts here so later reviewers, workers, and the extension read consistent answers."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,.7fr)]">
        <section className="panel p-5 sm:p-7">
          <SectionHeading
            title="Candidate profile"
            description="Comma-separate titles and locations. All other fields remain plain, reusable facts."
          />
          <form action={saveCandidateProfile} className="grid gap-5 sm:grid-cols-2">
            <label className="field sm:col-span-2">
              <span>Professional summary</span>
              <textarea
                name="summary"
                rows={5}
                defaultValue={profile?.summary ?? ""}
                placeholder="Senior engineer focused on product systems, platform reliability, and pragmatic automation…"
              />
            </label>
            <label className="field">
              <span>Target titles</span>
              <input
                name="targetTitles"
                defaultValue={profile?.targetTitles.join(", ") ?? ""}
                placeholder="Senior Software Engineer, Staff Engineer"
              />
            </label>
            <label className="field">
              <span>Target locations</span>
              <input
                name="targetLocations"
                defaultValue={profile?.targetLocations.join(", ") ?? ""}
                placeholder="New York, Remote"
              />
            </label>
            <label className="field sm:col-span-2">
              <span>Work authorization answer</span>
              <textarea
                name="workAuthorizationAnswer"
                rows={3}
                defaultValue={profile?.workAuthorizationAnswer ?? ""}
                placeholder="I am authorized to work in…"
              />
            </label>
            <label className="field sm:col-span-2">
              <span>Sponsorship answer</span>
              <textarea
                name="sponsorshipAnswer"
                rows={3}
                defaultValue={profile?.sponsorshipAnswer ?? ""}
                placeholder="I will / will not require sponsorship…"
              />
            </label>
            <label className="field sm:col-span-2">
              <span>Salary expectations</span>
              <input
                name="salaryExpectation"
                defaultValue={profile?.salaryExpectation ?? ""}
                placeholder="$160,000–$190,000 base, depending on total package"
              />
            </label>
            <label className="field">
              <span>LinkedIn URL</span>
              <input
                name="linkedinUrl"
                type="url"
                defaultValue={profile?.linkedinUrl ?? ""}
                placeholder="https://linkedin.com/in/..."
              />
            </label>
            <label className="field">
              <span>GitHub URL</span>
              <input
                name="githubUrl"
                type="url"
                defaultValue={profile?.githubUrl ?? ""}
                placeholder="https://github.com/..."
              />
            </label>
            <label className="field sm:col-span-2">
              <span>Portfolio URL</span>
              <input
                name="portfolioUrl"
                type="url"
                defaultValue={profile?.portfolioUrl ?? ""}
                placeholder="https://yourname.dev"
              />
            </label>
            <div className="sm:col-span-2">
              <button className="primary-button">
                <Save className="size-4" /> Save profile
              </button>
            </div>
          </form>
        </section>

        <aside className="space-y-6">
          <section className="panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <span className="metric-icon">
                <ShieldCheck className="size-4" />
              </span>
              <div>
                <p className="font-semibold text-[var(--ink)]">Data boundary</p>
                <p className="text-xs text-[var(--muted)]">Deliberately narrow</p>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
              Do not store account passwords, browser cookies, Codex credentials,
              or VPS access keys here. The profile contains application facts
              only.
            </p>
          </section>

          <section className="panel p-5 sm:p-6">
            <SectionHeading
              title="Resume versions"
              description="Store a link or path, not file bytes."
            />
            <div className="space-y-3">
              {resumes.map((resume) => (
                <div
                  key={resume.id}
                  className="rounded-2xl border border-[var(--line)] bg-white/55 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-[var(--ink)]">{resume.name}</p>
                    {resume.isDefault && (
                      <span className="source-chip">Default</span>
                    )}
                  </div>
                  <p className="mt-2 truncate text-xs text-[var(--muted)]">
                    {resume.storagePath}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Added {formatDate(resume.createdAt)}
                  </p>
                </div>
              ))}
              {!resumes.length && (
                <p className="rounded-xl bg-[var(--soft)] p-4 text-sm text-[var(--muted)]">
                  No resume versions saved.
                </p>
              )}
            </div>
            <details className="form-disclosure mt-4">
              <summary>Add a resume version</summary>
              <form action={addResumeVersion} className="mt-4 space-y-4">
                <label className="field">
                  <span>Name</span>
                  <input name="name" required placeholder="Product-focused v3" />
                </label>
                <label className="field">
                  <span>File URL or storage path</span>
                  <input
                    name="storagePath"
                    required
                    placeholder="https://storage.example/resume.pdf"
                  />
                </label>
                <label className="field">
                  <span>Notes</span>
                  <textarea name="notes" rows={2} />
                </label>
                <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
                  <input name="isDefault" type="checkbox" />
                  Make this the default version
                </label>
                <button className="secondary-button w-full">
                  <FileText className="size-4" /> Add version
                </button>
              </form>
            </details>
          </section>
        </aside>
      </div>

      <section className="panel mt-6 p-5 sm:p-7">
        <SectionHeading
          title="Common answers"
          description="Use stable snake_case keys. Reusing a key updates that answer."
        />
        <div className="grid gap-6 xl:grid-cols-[minmax(300px,.7fr)_minmax(0,1.3fr)]">
          <form action={saveCommonAnswer} className="rounded-2xl bg-[var(--soft)] p-5">
            <div className="mb-5 flex items-center gap-3">
              <BookOpenText className="size-5 text-[var(--accent-dark)]" />
              <p className="font-semibold text-[var(--ink)]">Add or update</p>
            </div>
            <div className="space-y-4">
              <label className="field">
                <span>Question key</span>
                <input name="questionKey" required placeholder="why_company" />
              </label>
              <label className="field">
                <span>Category</span>
                <input
                  name="category"
                  required
                  placeholder="motivation"
                />
              </label>
              <label className="field">
                <span>Question</span>
                <textarea
                  name="questionText"
                  required
                  rows={2}
                  placeholder="Why are you interested in this company?"
                />
              </label>
              <label className="field">
                <span>Answer</span>
                <textarea name="answerText" required rows={5} />
              </label>
              <button className="primary-button w-full">
                <Save className="size-4" /> Save answer
              </button>
            </div>
          </form>
          <div className="space-y-3">
            {answers.map((answer) => (
              <article
                key={answer.id}
                className="rounded-2xl border border-[var(--line)] bg-white/55 p-5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="source-chip">{answer.category}</span>
                  <span className="font-mono text-[11px] text-[var(--muted)]">
                    {answer.questionKey}
                  </span>
                </div>
                <p className="mt-3 font-semibold text-[var(--ink)]">
                  {answer.questionText}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--muted)]">
                  {answer.answerText}
                </p>
              </article>
            ))}
            {!answers.length && (
              <div className="empty-state">
                <Link2 className="mx-auto size-6 text-[var(--muted)]" />
                <p className="mt-3 text-sm text-[var(--muted)]">
                  Your reusable answer library is empty.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
