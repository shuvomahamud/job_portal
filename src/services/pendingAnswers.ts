import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { applications, jobs, pendingQuestions, type PendingQuestion } from "@/db/schema";
import { validateAnswerForQuestion } from "@/lib/answerValidation";
import { createCommand } from "@/services/commands";
import {
  chooseAnswerScope,
  learnAnswer,
} from "../../worker/src/formfill/answerBank";
import type { DetectedField, FieldCategory, RiskLevel } from "../../worker/src/formfill/types";

function fieldFromPending(question: PendingQuestion): DetectedField {
  const options = (question.optionsJson ?? []).map((option) => String(option ?? ""));
  return {
    id: question.fieldId ?? question.shortId,
    selector: question.fieldSelector ?? "",
    tagName: "input",
    inputType: question.answerType,
    labelText: question.questionText,
    normalizedQuestion: question.normalizedQuestion,
    placeholder: "",
    ariaLabel: "",
    name: "",
    idAttribute: "",
    required: question.required,
    options,
    currentValue: "",
    nearbyText: "",
    fieldCategory: question.category as FieldCategory,
    riskLevel: question.riskLevel as RiskLevel,
    confidence: 1,
  };
}

export async function acceptPendingAnswer(input: {
  question: PendingQuestion;
  rawAnswer: string;
  source: "user_reply" | "dashboard";
  company?: string;
  domain?: string;
}): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  const validated = validateAnswerForQuestion(
    {
      answerType: input.question.answerType,
      category: input.question.category,
      options: input.question.optionsJson ?? [],
      required: input.question.required,
    },
    input.rawAnswer,
  );
  if (!validated.ok) return validated;

  const db = getDb();
  const [job] = await db
    .select({ company: jobs.company, sourceUrl: jobs.sourceUrl })
    .from(jobs)
    .where(eq(jobs.id, input.question.jobId))
    .limit(1);

  const company = input.company ?? job?.company ?? "";
  let domain = input.domain ?? "";
  if (!domain && job?.sourceUrl) {
    try {
      domain = new URL(job.sourceUrl).hostname;
    } catch {
      domain = "";
    }
  }

  const field = fieldFromPending(input.question);
  const scope = chooseAnswerScope(field, company);
  const affectedQuestions = await db
    .select({ jobId: pendingQuestions.jobId })
    .from(pendingQuestions)
    .where(
      and(
        eq(pendingQuestions.userId, input.question.userId),
        eq(pendingQuestions.normalizedQuestion, input.question.normalizedQuestion),
        eq(pendingQuestions.category, input.question.category),
        eq(pendingQuestions.status, "open"),
      ),
    );
  await learnAnswer(
    {
      userId: input.question.userId,
      scope: scope.scope,
      scopeKey: scope.scopeKey,
      field,
      answerValue: validated.value,
      domain,
      source: input.source,
    },
    db,
  );

  const affectedJobIds = [...new Set(affectedQuestions.map((row) => row.jobId))];
  for (const jobId of affectedJobIds) {
    const [openRemaining] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingQuestions)
      .where(
        and(
          eq(pendingQuestions.userId, input.question.userId),
          eq(pendingQuestions.jobId, jobId),
          eq(pendingQuestions.status, "open"),
        ),
      );

    if ((openRemaining?.count ?? 0) === 0) {
      await db
        .update(applications)
        .set({ status: "ready", stopReason: "answers_completed", updatedAt: new Date() })
        .where(
          and(
            eq(applications.userId, input.question.userId),
            eq(applications.jobId, jobId),
            eq(applications.status, "awaiting_answer"),
          ),
        );
      await createCommand(
        {
          type: "apply_to_jobs",
          payloadJson: { jobIds: [jobId] },
          priority: "high",
        },
        { source: "system", requestedBy: input.question.userId },
      );
    }
  }

  return { ok: true, value: validated.value };
}
