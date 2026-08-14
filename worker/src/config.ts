import { config as loadEnv } from "dotenv";
import { z } from "zod";

if (process.env.WORKER_ENV_FILE) {
  loadEnv({ path: process.env.WORKER_ENV_FILE, quiet: true });
}
// Keep the repository env files as fallbacks for settings intentionally omitted from
// the Mac app's worker.env (notably DATABASE_URL and WORKER_API_SECRET). dotenv does
// not overwrite values loaded above, so worker-specific settings still win.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

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

export const browserChannelFromEnv = z.preprocess(
  (value) => value === "bundled" ? undefined : value,
  z.enum(["chrome", "msedge", "chrome-beta"]).optional(),
);

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
  // Every dashboard call is on the critical path of the poll loop, so one that never
  // answers stops the worker completely. These endpoints do a little Postgres work and
  // return; 30s is generous for that and still short enough to notice.
  WORKER_DASHBOARD_TIMEOUT_MS: intFromEnv(30000, 1000, 120000),
  WORKER_HEARTBEAT_INTERVAL_SECONDS: intFromEnv(120, 30, 600),
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
  // Ceiling for one discovery command. Kept high enough not to strangle a large apply
  // run: the cycle asks for roughly twice its apply target, and a 25 cap silently
  // reduced a 50-application request to 25 postings found.
  JOB_BROWSER_MAX_RESULTS_PER_COMMAND: intFromEnv(100, 1, 2000),
  JOB_BROWSER_MAX_PAGES_PER_SEARCH: intFromEnv(3, 1, 10),
  // "chrome" uses the installed Google Chrome binary instead of Playwright's bundled
  // Chromium. Still a separate profile directory, so the personal Chrome profile is untouched.
  // The Mac app writes "bundled" explicitly when that troubleshooting option is
  // selected. Treat it as no Playwright channel; a missing value is different because
  // the Mac app migrates missing legacy settings to installed Chrome.
  JOB_BROWSER_CHANNEL: browserChannelFromEnv,
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
  // "desktop" also raises a native notification through the JobAgent app.
  JOB_APPLY_NOTIFY_CHANNEL: z.enum(["desktop", "dashboard"]).default("desktop"),
  // Push notifications reach a phone and, through it, an Apple Watch — a macOS
  // notification never leaves the Mac. Additive: the desktop notification still fires.
  JOB_APPLY_PUSH_ENABLED: boolFromEnv(false),
  NTFY_SERVER: z.string().url().default("https://ntfy.sh"),
  // Anyone who knows a topic on the public server can read it, and these carry job titles
  // and company names. Use something long and unguessable.
  NTFY_TOPIC: z.string().trim().min(8).max(120).optional(),
  NTFY_TIMEOUT_MS: intFromEnv(10000, 1000, 60000),
  JOB_APPLY_QUESTION_TTL_HOURS: intFromEnv(72, 1, 720),
  JOB_APPLY_ENABLED: boolFromEnv(false),
  JOB_APPLY_MODE: z.enum(["dry_run", "fill_only", "fill_and_submit"]).default("dry_run"),
  JOB_APPLY_MAX_PER_RUN: intFromEnv(15, 1, 1000),
  JOB_APPLY_MAX_MINUTES_PER_APPLICATION: intFromEnv(20, 1, 120),
  JOB_APPLY_MAX_STEPS: intFromEnv(8, 1, 20),
  JOB_APPLY_MIN_GAP_SECONDS: intFromEnv(90, 0, 3600),
  JOB_APPLY_MAX_GAP_SECONDS: intFromEnv(420, 0, 7200),
  JOB_APPLY_ARTIFACT_DIR: z.string().optional(),
  JOB_APPLY_TRACE: boolFromEnv(true),
  JOB_APPLY_TRUST_LLM_ANSWERS: boolFromEnv(false),
  // Follow a posting off the job board and apply on the employer's own site. Off by
  // default: an off-board apply may create an account with that employer and submits a
  // form nobody has rehearsed, so it is opt-in per machine.
  JOB_APPLY_EXTERNAL_SITES_ENABLED: boolFromEnv(false),
  // Minimum match score for an off-board apply, inclusive. Far above the on-board bar
  // because the cost of a bad one is an account and an irreversible submission.
  JOB_APPLY_EXTERNAL_MIN_SCORE: intFromEnv(80, 0, 100),
  WORKER_OWNER_USER_ID: z.string().uuid().optional(),
});

export type WorkerConfig = z.infer<typeof envSchema> & {
  workerCommandTypes: string[];
  ollamaAllowedRemoteHosts: string[];
};

let cachedConfig: WorkerConfig | null = null;

export function getConfig(): WorkerConfig {
  if (cachedConfig) return cachedConfig;
  const parsed = envSchema.parse(process.env);
  if (parsed.WORKER_HEARTBEAT_INTERVAL_SECONDS * 4 >= 3600) {
    throw new Error(
      "WORKER_HEARTBEAT_INTERVAL_SECONDS * 4 must be < 3600 so heartbeats stay inside the 60-minute stale-claim window.",
    );
  }
  const configuredCommandTypes = parsed.WORKER_COMMAND_TYPES.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!configuredCommandTypes.includes("open_browser_login")) {
    configuredCommandTypes.push("open_browser_login");
  }
  cachedConfig = {
    ...parsed,
    DASHBOARD_BASE_URL: parsed.DASHBOARD_BASE_URL.replace(/\/$/, ""),
    workerCommandTypes: configuredCommandTypes,
    ollamaAllowedRemoteHosts: parsed.OLLAMA_ALLOWED_REMOTE_HOSTS.split(",").map((item) => item.trim()).filter(Boolean),
  };
  return cachedConfig;
}

/** Test-only: clear cached env so process.env mutations take effect. */
export function resetConfigCacheForTests() {
  cachedConfig = null;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
