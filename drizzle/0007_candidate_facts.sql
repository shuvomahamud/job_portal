CREATE TABLE IF NOT EXISTS "candidate_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"resume_version_id" uuid,
	"fact_key" text NOT NULL,
	"fact_value" text NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'resume' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_resume_version_id_resume_versions_id_fk" FOREIGN KEY ("resume_version_id") REFERENCES "public"."resume_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "candidate_facts_user_key_unique" ON "candidate_facts" USING btree ("user_id","fact_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_facts_user_idx" ON "candidate_facts" USING btree ("user_id");
