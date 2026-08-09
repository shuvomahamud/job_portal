ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'filling';--> statement-breakpoint
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'awaiting_answer';--> statement-breakpoint
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'submitting';--> statement-breakpoint
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'submission_unknown';--> statement-breakpoint
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'needs_manual';--> statement-breakpoint
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'blocked';--> statement-breakpoint
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'failed';--> statement-breakpoint
ALTER TYPE "public"."command_type" ADD VALUE IF NOT EXISTS 'run_apply_cycle';--> statement-breakpoint
ALTER TYPE "public"."command_type" ADD VALUE IF NOT EXISTS 'apply_to_jobs';--> statement-breakpoint
ALTER TYPE "public"."command_type" ADD VALUE IF NOT EXISTS 'sync_resume_text';--> statement-breakpoint
CREATE TABLE "application_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"scope_key" text DEFAULT '' NOT NULL,
	"normalized_question" text NOT NULL,
	"original_question" text NOT NULL,
	"category" text NOT NULL,
	"answer_value" text NOT NULL,
	"answer_type" text NOT NULL,
	"option_value" text,
	"site_pattern" text DEFAULT '',
	"domain" text DEFAULT '',
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"risk_level" text DEFAULT 'MEDIUM' NOT NULL,
	"source" text DEFAULT 'user_reply' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"notes" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_role_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"target_role_id" uuid NOT NULL,
	"resume_version_id" uuid,
	"status" text NOT NULL,
	"score" integer,
	"evidence_json" jsonb,
	"reasons" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"candidate_fingerprint" text,
	"job_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" text NOT NULL,
	"command_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"application_id" uuid,
	"user_id" uuid NOT NULL,
	"field_id" text,
	"field_selector" text,
	"question_text" text NOT NULL,
	"normalized_question" text NOT NULL,
	"category" text NOT NULL,
	"answer_type" text NOT NULL,
	"options_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"risk_level" text DEFAULT 'HIGH' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"channel" text DEFAULT 'dashboard' NOT NULL,
	"channel_message_id" text,
	"answer_value" text,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"locations" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"resume_version_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"max_applications_per_day" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resume_versions" ALTER COLUMN "storage_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "target_role_id" uuid;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "job_role_match_id" uuid;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "apply_url" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "confirmation_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "state_region" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "country" text DEFAULT 'United States';--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "current_company" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "current_title" text;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "years_total_experience" integer;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "blob_pathname" text;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "original_filename" text;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "resume_text" text;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "resume_text_chars" integer;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "text_extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "extraction_error" text;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_role_matches" ADD CONSTRAINT "job_role_matches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_role_matches" ADD CONSTRAINT "job_role_matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_role_matches" ADD CONSTRAINT "job_role_matches_target_role_id_target_roles_id_fk" FOREIGN KEY ("target_role_id") REFERENCES "public"."target_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_role_matches" ADD CONSTRAINT "job_role_matches_resume_version_id_resume_versions_id_fk" FOREIGN KEY ("resume_version_id") REFERENCES "public"."resume_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_command_id_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_roles" ADD CONSTRAINT "target_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_roles" ADD CONSTRAINT "target_roles_resume_version_id_resume_versions_id_fk" FOREIGN KEY ("resume_version_id") REFERENCES "public"."resume_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_answers_user_scope_question_unique" ON "application_answers" USING btree ("user_id","scope","scope_key","normalized_question","category");--> statement-breakpoint
CREATE INDEX "application_answers_user_category_idx" ON "application_answers" USING btree ("user_id","category");--> statement-breakpoint
CREATE INDEX "application_answers_user_scope_idx" ON "application_answers" USING btree ("user_id","scope","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_role_matches_user_job_role_unique" ON "job_role_matches" USING btree ("user_id","job_id","target_role_id");--> statement-breakpoint
CREATE INDEX "job_role_matches_user_status_score_idx" ON "job_role_matches" USING btree ("user_id","status","score" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "pending_questions_short_id_unique" ON "pending_questions" USING btree ("short_id");--> statement-breakpoint
CREATE INDEX "pending_questions_user_status_idx" ON "pending_questions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "pending_questions_command_idx" ON "pending_questions" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "target_roles_user_title_unique" ON "target_roles" USING btree ("user_id","title");--> statement-breakpoint
CREATE INDEX "target_roles_user_active_idx" ON "target_roles" USING btree ("user_id","active");--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_target_role_id_target_roles_id_fk" FOREIGN KEY ("target_role_id") REFERENCES "public"."target_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_role_match_id_job_role_matches_id_fk" FOREIGN KEY ("job_role_match_id") REFERENCES "public"."job_role_matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_superseded_by_resume_versions_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."resume_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DELETE FROM "applications" a USING "applications" b
  WHERE a."job_id" = b."job_id" AND a."user_id" = b."user_id" AND a."ctid" > b."ctid";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "applications_job_user_unique"
  ON "applications" ("job_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resume_versions_user_sha256_unique" ON "resume_versions" USING btree ("user_id","sha256");
