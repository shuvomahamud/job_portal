export type CommandType =
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
  | "reprocess_job";

export type Priority = "low" | "normal" | "high" | "urgent";
export type JobSource = "linkedin" | "indeed" | "dice" | "company_site" | "referral" | "manual" | "other";

export type DashboardCommand = {
  id: string;
  type: CommandType;
  source: string;
  requestedBy: string;
  payloadJson: Record<string, unknown>;
  status: "pending" | "claimed" | "completed" | "failed" | "canceled";
  priority: Priority;
  scheduledFor: string | Date;
  claimedBy: string | null;
  claimedAt: string | Date | null;
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
};

export type HandlerResult = Record<string, unknown>;
export type CommandHandler = (payload: unknown, context: HandlerContext) => Promise<HandlerResult>;
