import { z } from "zod";
import { getJobsForRuleFilter, insertRuleReview, updateJobAfterRuleFilter } from "../db";
import { evaluateJob } from "../rules/ruleEngine";
import type { HandlerContext, HandlerResult, NormalizedJobInput } from "../types";

const payloadSchema = z.object({
  jobIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  ruleset: z.string().trim().min(1).max(100).default("default"),
  limit: z.number().int().min(1).max(200).default(100).optional(),
}).strict();

export async function handleRunRuleFilter(
  payload: unknown,
  context: HandlerContext,
): Promise<HandlerResult> {
  const parsed = payloadSchema.parse(payload ?? {});
  const jobs = await getJobsForRuleFilter({ jobIds: parsed.jobIds, limit: parsed.limit ?? 100 });

  let readyToApply = 0;
  let needsReview = 0;
  let archived = 0;
  const processed: Array<{ jobId: string; score: number; status: string; recommendation: string }> = [];

  for (const job of jobs) {
    if (context.claimGuard.lost) break;
    const evaluation = evaluateJob(job as NormalizedJobInput & { id: string });
    await updateJobAfterRuleFilter(job.id, evaluation);
    await insertRuleReview(job.id, evaluation, parsed.ruleset);
    if (evaluation.status === "ready_to_apply") readyToApply += 1;
    if (evaluation.status === "needs_review") needsReview += 1;
    if (evaluation.status === "archived") archived += 1;
    processed.push({ jobId: job.id, score: evaluation.score, status: evaluation.status, recommendation: evaluation.recommendation });
  }

  return {
    ruleset: parsed.ruleset,
    processedCount: processed.length,
    readyToApply,
    needsReview,
    archived,
    processed,
    claimLost: context.claimGuard.lost,
  };
}
