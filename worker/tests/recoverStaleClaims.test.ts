import assert from "node:assert/strict";
import test from "node:test";
import { config as loadEnv } from "dotenv";
import { eq, sql } from "drizzle-orm";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

process.env.DASHBOARD_BASE_URL ??= "http://127.0.0.1:3000";
process.env.WORKER_API_SECRET ??= "test-worker-api-secret-16chars";
process.env.WORKER_ID ??= "job-worker-01";

test("recoverStaleClaims keeps a backdated claim alive when heartbeat_at is fresh", async (t) => {
  if (!process.env.DATABASE_URL) {
    t.skip("DATABASE_URL is required for recoverStaleClaims integration");
    return;
  }

  // Import after env defaults so getConfig() can parse.
  const schema = await import("../../src/db/schema.js");
  const { getWorkerDb, heartbeatCommand, recoverStaleClaims } = await import("../src/db.js");

  const database = getWorkerDb();
  const commandId = crypto.randomUUID();
  const workerId = process.env.WORKER_ID || "job-worker-01";

  await database.insert(schema.commands).values({
    id: commandId,
    type: "run_rule_filter",
    source: "system",
    requestedBy: "heartbeat-test",
    payloadJson: { ruleset: "default" },
    status: "claimed",
    claimedBy: workerId,
    claimedAt: new Date(Date.now() - 70 * 60 * 1000),
    heartbeatAt: new Date(),
  });

  t.after(async () => {
    await database.delete(schema.commandEvents).where(eq(schema.commandEvents.commandId, commandId));
    await database.delete(schema.commands).where(eq(schema.commands.id, commandId));
  });

  const recoveredWhileAlive = await recoverStaleClaims(60);
  assert.equal(recoveredWhileAlive.includes(commandId), false);

  const [alive] = await database
    .select({ status: schema.commands.status, claimedBy: schema.commands.claimedBy })
    .from(schema.commands)
    .where(eq(schema.commands.id, commandId))
    .limit(1);
  assert.equal(alive?.status, "claimed");
  assert.equal(alive?.claimedBy, workerId);

  const beat = await heartbeatCommand(commandId, workerId);
  assert.equal(beat, true);

  await database.execute(sql`
    UPDATE commands
    SET heartbeat_at = NULL, claimed_at = NOW() - INTERVAL '70 minutes'
    WHERE id = ${commandId}
  `);

  const recovered = await recoverStaleClaims(60);
  assert.equal(recovered.includes(commandId), true);

  const [row] = await database
    .select({ status: schema.commands.status, claimedBy: schema.commands.claimedBy })
    .from(schema.commands)
    .where(eq(schema.commands.id, commandId))
    .limit(1);
  assert.equal(row?.status, "pending");
  assert.equal(row?.claimedBy, null);

  const lostBeat = await heartbeatCommand(commandId, workerId);
  assert.equal(lostBeat, false);
});
