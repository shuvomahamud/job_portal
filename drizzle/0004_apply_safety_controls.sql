ALTER TYPE "public"."command_type" ADD VALUE 'verify_submission' BEFORE 'sync_resume_text';--> statement-breakpoint
CREATE TABLE "automation_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"apply_paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "job_role_matches_user_status_score_idx";--> statement-breakpoint
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_role_matches_user_status_score_idx" ON "job_role_matches" USING btree ("user_id","status","score" DESC NULLS LAST);
