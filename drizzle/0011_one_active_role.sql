-- Exactly one active target role per user. The active role decides which resume gets
-- submitted, so more than one active role makes that choice ambiguous.
-- Existing extras are deactivated, keeping the most recently updated role active.
UPDATE "target_roles" SET "active" = false, "updated_at" = now()
WHERE "active" = true
  AND "id" NOT IN (
    SELECT DISTINCT ON ("user_id") "id"
    FROM "target_roles"
    WHERE "active" = true
    ORDER BY "user_id", "updated_at" DESC
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "target_roles_one_active_per_user"
  ON "target_roles" USING btree ("user_id") WHERE "active";
