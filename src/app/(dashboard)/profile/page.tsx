import { desc, eq } from "drizzle-orm";
import {
  BookOpenText,
  Link2,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { getDb } from "@/db";
import {
  candidateFacts,
  candidateProfiles,
  commonAnswers,
  resumeVersions,
} from "@/db/schema";
import { PageHeader, SectionHeading } from "@/components/ui";
import { requireDashboardUser } from "@/lib/auth";
import {
  FACT_KEYS,
  factIsUsable,
  factLabel,
  type FactKey,
} from "@/lib/candidateFacts";
import { formatDate } from "@/lib/format";
import {
  deleteCandidateFact,
  saveCandidateFact,
  saveCandidateProfile,
  saveCommonAnswer,
} from "../actions";
import { resumeHealthLabel } from "@/lib/resumeHealth";

export default async function ProfilePage() {
  const user = await requireDashboardUser();
  const db = getDb();
  const [profiles, resumes, answers, facts] = await Promise.all([
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
    db
      .select()
      .from(candidateFacts)
      .where(eq(candidateFacts.userId, user.id))
      .orderBy(candidateFacts.factKey),
  ]);
  const profile = profiles[0];
  const factByKey = new Map(facts.map((fact) => [fact.factKey, fact]));
  const usableFactCount = facts.filter(factIsUsable).length;

  return (
    <>
      <PageHeader
        eyebrow="Candidate source of truth"
        title="Profile hub"
        description="Keep stable facts here so later reviewers and workers use consistent answers."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,.7fr)]">
        <section className="panel p-5 sm:p-7">
          <SectionHeading
            title="Candidate profile"
            description="Comma-separate titles and locations. All other fields remain plain, reusable facts."
          />
          <form action={saveCandidateProfile} className="grid gap-5 sm:grid-cols-2">
            <fieldset className="sm:col-span-2 grid gap-5 sm:grid-cols-2 rounded-2xl border border-[var(--line)] bg-[var(--soft)]/60 p-4">
              <legend className="px-1 text-sm font-semibold text-[var(--ink)]">
                Contact & identity
              </legend>
              <label className="field">
                <span>First name</span>
                <input name="firstName" defaultValue={profile?.firstName ?? ""} />
              </label>
              <label className="field">
                <span>Last name</span>
                <input name="lastName" defaultValue={profile?.lastName ?? ""} />
              </label>
              <label className="field">
                <span>Phone</span>
                <input name="phone" defaultValue={profile?.phone ?? ""} />
              </label>
              <label className="field">
                <span>Country</span>
                <input name="country" defaultValue={profile?.country ?? "United States"} />
              </label>
              <label className="field sm:col-span-2">
                <span>Address line 1</span>
                <input name="addressLine1" defaultValue={profile?.addressLine1 ?? ""} />
              </label>
              <label className="field sm:col-span-2">
                <span>Address line 2</span>
                <input name="addressLine2" defaultValue={profile?.addressLine2 ?? ""} />
              </label>
              <label className="field">
                <span>City</span>
                <input name="city" defaultValue={profile?.city ?? ""} />
              </label>
              <label className="field">
                <span>State / region</span>
                <input name="stateRegion" defaultValue={profile?.stateRegion ?? ""} />
              </label>
              <label className="field">
                <span>Postal code</span>
                <input name="postalCode" defaultValue={profile?.postalCode ?? ""} />
              </label>
              <label className="field">
                <span>Years of experience</span>
                <input
                  name="yearsTotalExperience"
                  type="number"
                  min={0}
                  max={60}
                  defaultValue={profile?.yearsTotalExperience ?? ""}
                />
              </label>
              <label className="field">
                <span>Current company</span>
                <input name="currentCompany" defaultValue={profile?.currentCompany ?? ""} />
              </label>
              <label className="field">
                <span>Current title</span>
                <input name="currentTitle" defaultValue={profile?.currentTitle ?? ""} />
              </label>
            </fieldset>
            <label className="field sm:col-span-2">
              <span>Professional summary</span>
              <textarea
                name="summary"
                rows={5}
                defaultValue={profile?.summary ?? ""}
                placeholder="Senior engineer focused on product systems, platform reliability, and pragmatic automation…"
              />
            </label>
            <label className="field sm:col-span-2">
              <span>Skills</span>
              <input
                name="skills"
                defaultValue={profile?.skills.join(", ") ?? ""}
                placeholder="C#, .NET, SQL Server, Oracle, Azure, React"
              />
            </label>
            <p className="sm:col-span-2 rounded-xl border border-[var(--line)] bg-[var(--soft)] p-3 text-sm text-[var(--muted)]">
              Target titles now live on <a className="text-link" href="/roles">/roles</a>.
              The legacy <code>target_titles</code> column is preserved for audit and will be
              dropped only after a later verified migration.
            </p>
            <label className="field sm:col-span-2">
              <span>Target locations (profile default)</span>
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
              <span>Preferred employment types</span>
              <input
                name="preferredEmploymentTypes"
                defaultValue={profile?.preferredEmploymentTypes.join(", ") ?? ""}
                placeholder="W2 contract, Contract-to-hire"
              />
            </label>
            <label className="field">
              <span>Deal breakers</span>
              <input
                name="dealBreakers"
                defaultValue={profile?.dealBreakers.join(", ") ?? ""}
                placeholder="C2C only, onsite in California"
              />
            </label>
            <label className="field sm:col-span-2">
              <span>Matching notes</span>
              <textarea
                name="matchingInstructions"
                rows={3}
                defaultValue={profile?.matchingInstructions ?? ""}
                placeholder="Optional context for evaluating roles, such as strongest domains or preferred work style."
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
              or access keys here. The profile contains application facts
              only.
            </p>
          </section>

          <section className="panel p-5 sm:p-6">
            <SectionHeading
              title="Resume versions"
              description="Managed by the JobAgent app on your Mac. Add or remove resumes there."
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
                    {resume.originalFilename ?? resume.storagePath ?? "No file"}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {resumeHealthLabel(resume)} · Added {formatDate(resume.createdAt)}
                  </p>
                </div>
              ))}
              {!resumes.length && (
                <p className="rounded-xl bg-[var(--soft)] p-4 text-sm text-[var(--muted)]">
                  No resume versions saved.
                </p>
              )}
            </div>
            <p className="mt-4 rounded-xl bg-[var(--soft)] p-4 text-xs text-[var(--muted)]">
              Resumes are stored by the JobAgent app on your Mac. Open its Resumes tab to
              add one, set the default, or remove it.
            </p>
          </section>
        </aside>
      </div>

      <section className="panel mt-6 p-5 sm:p-7">
        <SectionHeading
          title="Resume facts"
          description="Read from your resume when it is synced, then used to answer application fields automatically. Confirm or correct anything wrong — a confirmed fact is never overwritten by a later resume sync."
        />
        <p className="mb-5 rounded-xl border border-[var(--line)] bg-[var(--soft)] p-3 text-sm text-[var(--muted)]">
          {usableFactCount} of {FACT_KEYS.length} facts are confident enough to fill a form.
          Anything below {" "}
          <span className="font-mono text-xs">70%</span> confidence is shown here for review
          but will still be asked as a question during an application.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {FACT_KEYS.map((key: FactKey) => {
            const fact = factByKey.get(key);
            const usable = fact ? factIsUsable(fact) : false;
            return (
              <div
                key={key}
                className="rounded-2xl border border-[var(--line)] bg-white/55 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-[var(--ink)]">{factLabel(key)}</p>
                  {fact ? (
                    <span className="source-chip">
                      {fact.verified
                        ? "Confirmed"
                        : usable
                          ? `${fact.confidence}% confident`
                          : `${fact.confidence}% — will ask`}
                    </span>
                  ) : (
                    <span className="source-chip">Not found</span>
                  )}
                </div>
                <form action={saveCandidateFact} className="mt-3 flex items-end gap-2">
                  <input type="hidden" name="factKey" value={key} />
                  <label className="field flex-1">
                    <span className="sr-only">{factLabel(key)}</span>
                    <input
                      name="factValue"
                      required
                      defaultValue={fact?.factValue ?? ""}
                      placeholder={
                        key.startsWith("years_") ? "Whole number of years" : "Not set"
                      }
                    />
                  </label>
                  <button className="primary-button" aria-label={`Confirm ${factLabel(key)}`}>
                    <Save className="size-4" />
                  </button>
                </form>
                {fact?.evidence && (
                  <p className="mt-3 border-l-2 border-[var(--line)] pl-3 text-xs italic leading-5 text-[var(--muted)]">
                    “{fact.evidence}”
                  </p>
                )}
                {fact && (
                  <form action={deleteCandidateFact} className="mt-3">
                    <input type="hidden" name="factId" value={fact.id} />
                    <button className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)]">
                      <Trash2 className="size-3.5" /> Remove
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        {!facts.length && (
          <div className="empty-state mt-5">
            <Sparkles className="mx-auto size-6 text-[var(--muted)]" />
            <p className="mt-3 text-sm text-[var(--muted)]">
              No facts read yet. They are extracted the next time a resume is synced, or
              you can fill them in above.
            </p>
          </div>
        )}
      </section>

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
