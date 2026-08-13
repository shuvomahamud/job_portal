ALTER TYPE "public"."command_type" ADD VALUE 'open_browser_login';--> statement-breakpoint
CREATE TABLE "automation_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"command_id" uuid,
	"kind" text NOT NULL,
	"site" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"message" text NOT NULL,
	"page_url" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_alerts" ADD CONSTRAINT "automation_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_alerts" ADD CONSTRAINT "automation_alerts_command_id_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_alerts_user_status_idx" ON "automation_alerts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "automation_alerts_command_idx" ON "automation_alerts" USING btree ("command_id");