import type { ClaimGuard } from "./claimHeartbeat";

export type CommandType =
  | "find_matching_jobs"
  | "run_job_search"
  | "discover_jobs_browser"
  | "import_jobs"
  | "run_rule_filter"
  | "run_local_llm_extraction"
  | "review_top_jobs"
  | "review_job"
  | "draft_answer"
  | "trigger_n8n_summary"
  | "sync_n8n_email_events"
  | "mark_application_status"
  | "reprocess_job"
  | "run_apply_cycle"
  | "apply_to_jobs"
  | "sync_resume_text";

export type WorkerSpawnableCommandType =
  | "run_local_llm_extraction"
  | "find_matching_jobs"
  | "discover_jobs_browser"
  | "apply_to_jobs"
  | "run_apply_cycle"
  | "sync_resume_text";

export type Priority = "low" | "normal" | "high" | "urgent";
export type JobSource = "linkedin" | "indeed" | "dice" | "company_site" | "referral" | "manual" | "other";

export type DashboardCommand = {
  id: string;
  parentCommandId?: string | null;
  type: CommandType;
  source: string;
  requestedBy: string;
  payloadJson: Record<string, unknown>;
  status: "pending" | "claimed" | "completed" | "failed" | "canceled";
  priority: Priority;
  scheduledFor: string | Date;
  claimedBy: string | null;
  claimedAt: string | Date | null;
  heartbeatAt?: string | Date | null;
  completedAt: string | Date | null;
  resultJson: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
};

export type NormalizedJobInput = {
  title: string;
  company: string;
  location?: string | null;
  source: JobSource;
  sourceUrl: string;
  postedDate?: Date | null;
  description: string;
  salaryText?: string | null;
  employmentType?: string | null;
  remoteType?: string | null;
  status?: "new" | "needs_review" | "reviewing" | "ready_to_apply" | "applied" | "interview" | "offer" | "rejected" | "archived";
  fitScore?: number | null;
  priority?: Priority;
  visaSignal?: string;
  techStack?: string[];
  notes?: string | null;
};

export type HandlerContext = {
  command: DashboardCommand;
  claimGuard: ClaimGuard;
};

export type HandlerResult = Record<string, unknown>;
export type CommandHandler = (payload: unknown, context: HandlerContext) => Promise<HandlerResult>;
