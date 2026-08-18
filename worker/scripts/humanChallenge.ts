/**
 * Pause / resume for the JobAgent app.
 *
 * The Mac app has no database driver, so it shells out here. `status` is what to show
 * on the Control tab; `resume` is the button that tells the waiting apply to continue.
 *
 *   tsx worker/scripts/humanChallenge.ts status
 *   tsx worker/scripts/humanChallenge.ts pause
 *   tsx worker/scripts/humanChallenge.ts resume
 *
 * Requires DATABASE_URL and WORKER_OWNER_USER_ID.
 */
import { config as loadEnv } from "dotenv";
import { and, eq } from "drizzle-orm";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.local", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import * as schema from "../../src/db/schema";
import { getScriptDb } from "../src/scriptDb";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerUserId(): string {
  const value = process.env.WORKER_OWNER_USER_ID?.trim();
  if (!value) {
    throw new Error("WORKER_OWNER_USER_ID is not set. Add your user ID in JobAgent settings.");
  }
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`WORKER_OWNER_USER_ID is not a valid UUID: ${value}`);
  }
  return value;
}

async function status() {
  const userId = ownerUserId();
  const db = getScriptDb();
  const [settings] = await db
    .select({ applyPaused: schema.automationSettings.applyPaused })
    .from(schema.automationSettings)
    .where(eq(schema.automationSettings.userId, userId))
    .limit(1);
  const alerts = await db
    .select({
      id: schema.automationAlerts.id,
      kind: schema.automationAlerts.kind,
      site: schema.automationAlerts.site,
      message: schema.automationAlerts.message,
      pageUrl: schema.automationAlerts.pageUrl,
    })
    .from(schema.automationAlerts)
    .where(
      and(eq(schema.automationAlerts.userId, userId), eq(schema.automationAlerts.status, "open")),
    );
  return {
    paused: settings?.applyPaused ?? false,
    alerts: alerts.map((alert) => ({
      id: alert.id,
      kind: alert.kind,
      site: alert.site,
      message: alert.message,
      pageUrl: alert.pageUrl,
    })),
  };
}

async function setPaused(paused: boolean) {
  const userId = ownerUserId();
  const db = getScriptDb();
  const now = new Date();
  await db
    .insert(schema.automationSettings)
    .values({ userId, applyPaused: paused, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.automationSettings.userId,
      set: { applyPaused: paused, updatedAt: now },
    });
  if (!paused) {
    const resolved = await db
      .update(schema.automationAlerts)
      .set({ status: "resolved", resolvedAt: now, updatedAt: now })
      .where(
        and(eq(schema.automationAlerts.userId, userId), eq(schema.automationAlerts.status, "open")),
      )
      .returning({ id: schema.automationAlerts.id });
    return { ok: true, paused: false, unpaused: true, resolved: resolved.length };
  }
  return { ok: true, paused: true };
}

async function resume() {
  return setPaused(false);
}

async function pause() {
  return setPaused(true);
}

async function main() {
  const action = process.argv[2] ?? "status";
  if (action === "status") return status();
  if (action === "resume") return resume();
  if (action === "pause") return pause();
  throw new Error(`Unknown action: ${action}. Use status, pause, or resume.`);
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
