/**
 * Database access for the small CLI scripts the JobAgent app drives.
 *
 * These scripts deliberately avoid getWorkerDb: that path builds the full worker config and
 * fails when DASHBOARD_BASE_URL or WORKER_API_SECRET are unset, which is exactly the state
 * a user is in while first setting the app up. Only a database URL is needed here.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../../src/db/schema";

let database: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getScriptDb() {
  if (database) return database;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set. Add it in JobAgent settings.");
  database = drizzle(neon(url), { schema });
  return database;
}
