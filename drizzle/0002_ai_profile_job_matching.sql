ALTER TYPE "public"."command_type" ADD VALUE 'find_matching_jobs' BEFORE 'run_job_search';--> statement-breakpoint
ALTER TYPE "public"."command_type" ADD VALUE IF NOT EXISTS 'discover_jobs_browser' BEFORE 'import_jobs';--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "skills" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "preferred_employment_types" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "deal_breakers" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_profile" ADD COLUMN "matching_instructions" text;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "parent_command_id" uuid;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_parent_command_id_commands_id_fk" FOREIGN KEY ("parent_command_id") REFERENCES "public"."commands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commands_parent_idx" ON "commands" USING btree ("parent_command_id");
