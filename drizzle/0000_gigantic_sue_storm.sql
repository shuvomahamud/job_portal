CREATE TYPE "public"."application_status" AS ENUM('draft', 'ready', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."command_source" AS ENUM('dashboard', 'hermes', 'worker', 'n8n', 'system');--> statement-breakpoint
CREATE TYPE "public"."command_status" AS ENUM('pending', 'claimed', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."command_type" AS ENUM('run_job_search', 'import_jobs', 'run_rule_filter', 'run_local_llm_extraction', 'review_top_jobs', 'review_job', 'draft_answer', 'trigger_n8n_summary', 'sync_n8n_email_events', 'mark_application_status', 'reprocess_job');--> statement-breakpoint
CREATE TYPE "public"."followup_status" AS ENUM('pending', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('new', 'needs_review', 'reviewing', 'ready_to_apply', 'applied', 'interview', 'offer', 'rejected', 'archived');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."reviewer_type" AS ENUM('manual', 'rule_engine', 'local_llm', 'codex');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "application_status" DEFAULT 'draft' NOT NULL,
	"resume_version_id" uuid,
	"applied_at" timestamp with time zone,
	"followup_at" timestamp with time zone,
	"recruiter_name" text,
	"recruiter_email" text,
	"application_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_titles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"target_locations" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"work_authorization_answer" text,
	"sponsorship_answer" text,
	"salary_expectation" text,
	"linkedin_url" text,
	"github_url" text,
	"portfolio_url" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "command_type" NOT NULL,
	"source" "command_source" NOT NULL,
	"requested_by" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "command_status" DEFAULT 'pending' NOT NULL,
	"priority" "priority" DEFAULT 'normal' NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result_json" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "common_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question_text" text NOT NULL,
	"answer_text" text NOT NULL,
	"category" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"application_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"status" "followup_status" DEFAULT 'pending' NOT NULL,
	"message_template" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"reviewer_type" "reviewer_type" NOT NULL,
	"score" integer,
	"recommendation" text,
	"strengths" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"gaps" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"visa_notes" text,
	"resume_angle" text,
	"raw_output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"location" text,
	"source" text NOT NULL,
	"source_url" text NOT NULL,
	"posted_date" date,
	"description" text NOT NULL,
	"salary_text" text,
	"employment_type" text,
	"remote_type" text,
	"status" "job_status" DEFAULT 'new' NOT NULL,
	"fit_score" integer,
	"priority" "priority" DEFAULT 'normal' NOT NULL,
	"visa_signal" text DEFAULT 'unknown' NOT NULL,
	"tech_stack" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"storage_path" text NOT NULL,
	"notes" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"auth_provider_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_resume_version_id_resume_versions_id_fk" FOREIGN KEY ("resume_version_id") REFERENCES "public"."resume_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD CONSTRAINT "candidate_profile_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_events" ADD CONSTRAINT "command_events_command_id_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "common_answers" ADD CONSTRAINT "common_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reviews" ADD CONSTRAINT "job_reviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_user_idx" ON "applications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "applications_job_idx" ON "applications" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_profile_user_unique" ON "candidate_profile" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "command_events_command_idx" ON "command_events" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "commands_queue_idx" ON "commands" USING btree ("status","scheduled_for","priority");--> statement-breakpoint
CREATE INDEX "commands_type_idx" ON "commands" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "common_answers_user_question_unique" ON "common_answers" USING btree ("user_id","question_key");--> statement-breakpoint
CREATE INDEX "followups_due_idx" ON "followups" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "followups_status_idx" ON "followups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "integration_events_source_idx" ON "integration_events" USING btree ("source");--> statement-breakpoint
CREATE INDEX "integration_events_processed_idx" ON "integration_events" USING btree ("processed");--> statement-breakpoint
CREATE INDEX "job_reviews_job_idx" ON "job_reviews" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_source_idx" ON "jobs" USING btree ("source");--> statement-breakpoint
CREATE INDEX "jobs_fit_score_idx" ON "jobs" USING btree ("fit_score");--> statement-breakpoint
CREATE INDEX "jobs_company_idx" ON "jobs" USING btree ("company");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_url_unique" ON "jobs" USING btree ("source_url");--> statement-breakpoint
CREATE INDEX "resume_versions_user_idx" ON "resume_versions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_provider_id_unique" ON "users" USING btree ("auth_provider_id");