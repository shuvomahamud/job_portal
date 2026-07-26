import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.local", quiet: true });
loadEnv({ path: process.env.WORKER_ENV_FILE || ".env", quiet: true });

const intFromEnv = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

export const boolFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    return value;
  }, z.boolean().default(defaultValue));

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DASHBOARD_BASE_URL: z.string().url(),
  WORKER_API_SECRET: z.string().min(16),
  WORKER_ID: z.string().min(2).max(120).default("job-worker-01"),
  WORKER_POLL_INTERVAL_SECONDS: intFromEnv(10, 5, 3600),
  WORKER_CLAIM_LIMIT: intFromEnv(1, 1, 5),
  WORKER_MAX_CONCURRENCY: intFromEnv(1, 1, 3),
  WORKER_COMMAND_TYPES: z.string().default("find_matching_jobs,run_job_search,import_jobs,run_rule_filter"),
  WORKER_IDLE_BACKOFF_MAX_SECONDS: intFromEnv(60, 10, 600),
  JOB_SEARCH_MAX_RESULTS_PER_COMMAND: intFromEnv(50, 1, 200),
  JOB_SOURCE_DELAY_MS: intFromEnv(3000, 0, 60000),
  JOB_IMPORT_FETCH_TIMEOUT_MS: intFromEnv(12000, 1000, 60000),
  JOB_IMPORT_FETCH_DESCRIPTIONS: boolFromEnv(false),
  JOB_BROWSER_DISCOVERY_ENABLED: boolFromEnv(false),
  JOB_BROWSER_USER_DATA_DIR: z.string().min(1).default("/home/shuvo/.job-worker-browser-profile"),
  JOB_BROWSER_HEADLESS: boolFromEnv(false),
  JOB_BROWSER_MIN_DELAY_MS: intFromEnv(15000, 5000, 120000),
  JOB_BROWSER_MAX_DELAY_MS: intFromEnv(45000, 5000, 180000),
  JOB_BROWSER_SLOW_MO_MS: intFromEnv(500, 0, 5000),
  JOB_BROWSER_NAVIGATION_TIMEOUT_MS: intFromEnv(60000, 10000, 180000),
  JOB_BROWSER_MAX_RESULTS_PER_COMMAND: intFromEnv(25, 1, 100),
  JOB_BROWSER_MAX_PAGES_PER_SEARCH: intFromEnv(1, 1, 5),
  JOB_BROWSER_CDP_URL: z.string().url().optional(),
  JOB_BROWSER_CDP_MANAGE_PAGES: boolFromEnv(false),
  JOB_BROWSER_CDP_CONNECT_TIMEOUT_MS: intFromEnv(30000, 5000, 120000),
  JOB_BROWSER_CDP_CLEANUP_TIMEOUT_MS: intFromEnv(10000, 1000, 60000),
  AI_MATCH_PROVIDER: z.literal("ollama").default("ollama"),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_ALLOWED_REMOTE_HOSTS: z.string().default(""),
  OLLAMA_MODEL: z.string().trim().min(1).max(100).default("qwen3.5:9b"),
  OLLAMA_REQUEST_TIMEOUT_MS: intFromEnv(90000, 1000, 180000),
  OLLAMA_KEEP_ALIVE: z.string().trim().min(1).max(30).default("30m"),
  AI_MATCH_MAX_CONCURRENCY: intFromEnv(1, 1, 1),
  AI_MATCH_MAX_JOB_DESCRIPTION_CHARS: intFromEnv(50000, 1000, 50000),
  AI_MATCH_RETRY_LIMIT: intFromEnv(1, 0, 2),
  REMOTE_AI_REVIEW_ENABLED: boolFromEnv(false),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_REVIEW_MODEL: z.string().trim().min(1).max(100).default("gpt-5.6-terra"),
  OPENAI_REVIEW_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  OPENAI_REVIEW_TIMEOUT_MS: intFromEnv(90000, 1000, 180000),
  REMOTE_AI_REVIEW_MAX_PER_RUN: intFromEnv(5, 0, 50),
});

export type WorkerConfig = z.infer<typeof envSchema> & {
  workerCommandTypes: string[];
  ollamaAllowedRemoteHosts: string[];
};

let cachedConfig: WorkerConfig | null = null;

export function getConfig(): WorkerConfig {
  if (cachedConfig) return cachedConfig;
  const parsed = envSchema.parse(process.env);
  cachedConfig = {
    ...parsed,
    DASHBOARD_BASE_URL: parsed.DASHBOARD_BASE_URL.replace(/\/$/, ""),
    workerCommandTypes: parsed.WORKER_COMMAND_TYPES.split(",").map((item) => item.trim()).filter(Boolean),
    ollamaAllowedRemoteHosts: parsed.OLLAMA_ALLOWED_REMOTE_HOSTS.split(",").map((item) => item.trim()).filter(Boolean),
  };
  return cachedConfig;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
