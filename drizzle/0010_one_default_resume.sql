-- At most one default resume per user. Two rows claiming the default made role resume
-- selection non-deterministic. Any pre-existing duplicates are demoted to the newest row
-- first, otherwise the index cannot be created.
UPDATE "resume_versions" SET "is_default" = false
WHERE "is_default" = true
  AND "id" NOT IN (
    SELECT DISTINCT ON ("user_id") "id"
    FROM "resume_versions"
    WHERE "is_default" = true
    ORDER BY "user_id", "created_at" DESC
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resume_versions_one_default_per_user"
  ON "resume_versions" USING btree ("user_id") WHERE "is_default";
