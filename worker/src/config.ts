import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.local", quiet: true });
loadEnv({ path: process.env.WORKER_ENV_FILE || ".env", quiet: true });

const intFromEnv = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DASHBOARD_BASE_URL: z.string().url(),
  WORKER_API_SECRET: z.string().min(16),
  WORKER_ID: z.string().min(2).max(120).default("job-worker-01"),
  WORKER_POLL_INTERVAL_SECONDS: intFromEnv(10, 5, 3600),
  WORKER_CLAIM_LIMIT: intFromEnv(1, 1, 5),
  WORKER_MAX_CONCURRENCY: intFromEnv(1, 1, 3),
  WORKER_COMMAND_TYPES: z.string().default("run_job_search,import_jobs"),
  WORKER_IDLE_BACKOFF_MAX_SECONDS: intFromEnv(60, 10, 600),
  JOB_SEARCH_MAX_RESULTS_PER_COMMAND: intFromEnv(50, 1, 200),
  JOB_SOURCE_DELAY_MS: intFromEnv(3000, 0, 60000),
  JOB_IMPORT_FETCH_TIMEOUT_MS: intFromEnv(12000, 1000, 60000),
  JOB_IMPORT_FETCH_DESCRIPTIONS: z.coerce.boolean().default(false),
  CODEX_ENABLED: z.coerce.boolean().default(false),
});

export type WorkerConfig = z.infer<typeof envSchema> & { workerCommandTypes: string[] };

let cachedConfig: WorkerConfig | null = null;

export function getConfig(): WorkerConfig {
  if (cachedConfig) return cachedConfig;
  const parsed = envSchema.parse(process.env);
  cachedConfig = {
    ...parsed,
    DASHBOARD_BASE_URL: parsed.DASHBOARD_BASE_URL.replace(/\/$/, ""),
    workerCommandTypes: parsed.WORKER_COMMAND_TYPES.split(",").map((item) => item.trim()).filter(Boolean),
  };
  return cachedConfig;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
