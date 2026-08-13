CREATE TABLE IF NOT EXISTS "candidate_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"state_region" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text DEFAULT 'United States' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"match_terms" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_addresses" ADD CONSTRAINT "candidate_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "candidate_addresses_user_label_unique" ON "candidate_addresses" USING btree ("user_id","label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_addresses_user_idx" ON "candidate_addresses" USING btree ("user_id");
