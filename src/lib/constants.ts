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

/**
 * Job statuses that describe one candidate's outcome rather than the posting itself.
 * `jobs` is shared across users and carries no user_id, so these are never stored there;
 * filtering by one resolves through the current user's `applications` row instead.
 */
export const PER_USER_JOB_STATUSES = [
  "applied",
  "interview",
  "offer",
  "rejected",
] as const;

export function isPerUserJobStatus(
  status: string,
): status is (typeof PER_USER_JOB_STATUSES)[number] {
  return (PER_USER_JOB_STATUSES as readonly string[]).includes(status);
}

export const APPLICATION_STATUSES = [
  "draft",
  "ready",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "filling",
  "awaiting_answer",
  "submitting",
  "submission_unknown",
  "needs_manual",
  "blocked",
  "failed",
] as const;

export const APPLY_MODES = ["dry_run", "fill_only", "fill_and_submit"] as const;

export const FOLLOWUP_STATUSES = [
  "pending",
  "completed",
  "skipped",
] as const;

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const COMMAND_TYPES = [
  "find_matching_jobs",
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
  "run_apply_cycle",
  "apply_to_jobs",
  "verify_submission",
  "sync_resume_text",
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

// Historical/manual jobs can retain their original source. Automated discovery
// is intentionally limited to sources supported by the current workflow.
export const AUTOMATED_JOB_SOURCES = ["indeed", "dice"] as const;

// LinkedIn remains valid only for historical rows already in the database.
// New intake and filter UIs deliberately omit it.
export const SELECTABLE_JOB_SOURCES = [
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
    name: "Mac worker",
    variable: "WORKER_API_SECRET",
    purpose: "Claims queued work and reports completion or failure.",
  },
  {
    name: "n8n",
    variable: "N8N_WEBHOOK_SECRET",
    purpose: "Records email and workflow events for later processing.",
  },
] as const;
