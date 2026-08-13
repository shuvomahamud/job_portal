/**
 * Lists dashboard users so the JobAgent app can fill in the owner user ID without asking
 * anyone to look up a UUID by hand.
 *
 *   tsx worker/scripts/listUsers.ts
 *
 * Requires DATABASE_URL.
 */
import { config as loadEnv } from "dotenv";
import { asc } from "drizzle-orm";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.local", quiet: true });
loadEnv({ path: process.env.WORKER_ENV_FILE || ".env", quiet: true });

import * as schema from "../../src/db/schema";
import { getScriptDb } from "../src/scriptDb";

/** Seed and crash-test rows use example.com and would only confuse the picker. */
function looksLikeTestAccount(email: string): boolean {
  return /@example\.(com|org|net)$/i.test(email.trim());
}

async function main() {
  const rows = await getScriptDb()
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .orderBy(asc(schema.users.createdAt));

  return {
    users: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      isLikelyTestAccount: looksLikeTestAccount(row.email),
    })),
  };
}

main()
  .then((result) => {
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
