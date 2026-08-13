import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, pendingQuestions } from "@/db/schema";
import { EmptyState, PageHeader, SectionHeading, StatusBadge } from "@/components/ui";
import { requireDashboardUser } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { answerPendingQuestion, dismissPendingQuestion } from "../actions";

export default async function QuestionsPage() {
  const user = await requireDashboardUser();
  const db = getDb();
  const openQuestions = await db
    .select({
      question: pendingQuestions,
      jobTitle: jobs.title,
      company: jobs.company,
    })
    .from(pendingQuestions)
    .leftJoin(jobs, eq(jobs.id, pendingQuestions.jobId))
    .where(
      and(eq(pendingQuestions.userId, user.id), eq(pendingQuestions.status, "open")),
    )
    .orderBy(desc(pendingQuestions.createdAt));

  return (
    <>
      <PageHeader
        eyebrow="Apply assistance"
        title="Pending questions"
        description="Answer once here. The apply command retries automatically when nothing remains open for that job."
      />

      <section className="panel p-5 sm:p-7">
        <SectionHeading
          title="Open"
          description="These blocked an automated apply. Validated answers are learned into the answer bank."
        />
        {openQuestions.length === 0 ? (
          <EmptyState
            title="No open questions"
            description="When the Mac worker hits an unresolved field, it shows up here."
          />
        ) : (
          <div className="space-y-4">
            {openQuestions.map(({ question, jobTitle, company }) => {
              const options = (question.optionsJson ?? []).map((option) =>
                String(option ?? ""),
              );
              return (
                <article
                  key={question.id}
                  className="rounded-2xl border border-[var(--line)] bg-white/70 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm text-[var(--muted)]">
                        {jobTitle ?? "Job"} · {company ?? "Company"}
                      </p>
                      <h3 className="mt-1 text-base font-semibold">{question.questionText}</h3>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <StatusBadge value={question.category} />
                        <StatusBadge value={question.riskLevel} tone="warning" />
                        {question.required ? <StatusBadge value="required" /> : null}
                      </div>
                    </div>
                    <p className="text-xs text-[var(--muted)]">
                      Expires {formatDate(question.expiresAt)}
                    </p>
                  </div>

                  <form action={answerPendingQuestion} className="mt-4 space-y-3">
                    <input type="hidden" name="questionId" value={question.id} />
                    {options.length ? (
                      <select name="answer" className="field" required defaultValue="">
                        <option value="" disabled>
                          Select an answer
                        </option>
                        {options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <textarea
                        name="answer"
                        className="field min-h-24"
                        required
                        placeholder="Type your answer"
                      />
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button type="submit" className="primary-button">
                        Save answer
                      </button>
                    </div>
                  </form>
                  <form action={dismissPendingQuestion} className="mt-2">
                    <input type="hidden" name="questionId" value={question.id} />
                    <button type="submit" className="secondary-button">
                      Dismiss
                    </button>
                  </form>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
