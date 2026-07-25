import { z } from "zod";
import { getConfig, sleep } from "../config";
import { upsertJobs } from "../db";
import { normalizeUrlJob } from "../importer/fetchJob";
import type { HandlerResult, JobSource } from "../types";

const payloadSchema = z.object({
  source: z.enum(["linkedin", "indeed", "dice", "company_site", "other"]),
  urls: z.array(z.string().url()).min(1).max(100),
  batchId: z.string().uuid().optional(),
}).strict();

export async function handleImportJobs(payload: unknown): Promise<HandlerResult> {
  const cfg = getConfig();
  const input = payloadSchema.parse(payload);
  const normalized = [];
  const errors: Array<{ url: string; error: string }> = [];

  for (const url of input.urls) {
    try {
      normalized.push(await normalizeUrlJob(url, input.source as JobSource));
    } catch (error) {
      errors.push({ url, error: error instanceof Error ? error.message : "Unknown import error" });
    }
    if (cfg.JOB_SOURCE_DELAY_MS > 0) await sleep(Math.min(cfg.JOB_SOURCE_DELAY_MS, 5000));
  }

  const jobs = await upsertJobs(normalized);
  return {
    imported: jobs.length,
    attempted: input.urls.length,
    errors,
    jobIds: jobs.map((job) => job.id),
    batchId: input.batchId ?? null,
  };
}
