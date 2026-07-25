export const JOB_STATUSES = [
  "new",
  "needs_review",
  "reviewing",
  "ready_to_apply",
  "applied",
  "interview",
  "offer",
  "rejected",
  "archived",
] as const;

export const APPLICATION_STATUSES = [
  "draft",
  "ready",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
] as const;

export const FOLLOWUP_STATUSES = [
  "pending",
  "completed",
  "skipped",
] as const;

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const COMMAND_TYPES = [
  "run_job_search",
  "discover_jobs_browser",
  "import_jobs",
  "run_rule_filter",
  "run_local_llm_extraction",
  "review_top_jobs",
  "review_job",
  "draft_answer",
  "trigger_n8n_summary",
  "sync_n8n_email_events",
  "mark_application_status",
  "reprocess_job",
] as const;

export const COMMAND_STATUSES = [
  "pending",
  "claimed",
  "completed",
  "failed",
  "canceled",
] as const;

export const JOB_SOURCES = [
  "linkedin",
  "indeed",
  "dice",
  "company_site",
  "referral",
  "manual",
  "other",
] as const;

export const INTEGRATIONS = [
  {
    name: "Hermes",
    variable: "HERMES_COMMAND_SECRET",
    purpose: "Creates structured commands from your conversational interface.",
  },
  {
    name: "VPS worker",
    variable: "WORKER_API_SECRET",
    purpose: "Claims queued work and reports completion or failure.",
  },
  {
    name: "n8n",
    variable: "N8N_WEBHOOK_SECRET",
    purpose: "Records email and workflow events for later processing.",
  },
  {
    name: "Browser extension",
    variable: "EXTENSION_API_SECRET",
    purpose: "Reads a constrained candidate profile and individual job context.",
  },
] as const;
