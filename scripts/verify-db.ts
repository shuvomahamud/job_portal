import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/connection";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

type CountRow = {
  table_name: string;
  row_count: number;
};

async function verifyDatabase() {
  const result = await getDb().execute<CountRow>(sql`
    SELECT 'users' AS table_name, COUNT(*)::int AS row_count FROM users
    UNION ALL SELECT 'jobs', COUNT(*)::int FROM jobs
    UNION ALL SELECT 'candidate_profile', COUNT(*)::int FROM candidate_profile
    UNION ALL SELECT 'resume_versions', COUNT(*)::int FROM resume_versions
    UNION ALL SELECT 'common_answers', COUNT(*)::int FROM common_answers
    UNION ALL SELECT 'applications', COUNT(*)::int FROM applications
    UNION ALL SELECT 'job_reviews', COUNT(*)::int FROM job_reviews
    UNION ALL SELECT 'followups', COUNT(*)::int FROM followups
    UNION ALL SELECT 'commands', COUNT(*)::int FROM commands
    UNION ALL SELECT 'command_events', COUNT(*)::int FROM command_events
    UNION ALL SELECT 'integration_events', COUNT(*)::int FROM integration_events
  `);

  if (result.rows.length !== 11) {
    throw new Error(
      `Expected 11 application tables, received ${result.rows.length}.`,
    );
  }

  console.table(result.rows);
  console.log("Neon verification passed: all 11 application tables are live.");
}

verifyDatabase().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
