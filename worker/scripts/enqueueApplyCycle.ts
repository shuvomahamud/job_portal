import { getConfig } from "../src/config";
import { getWorkerDb } from "../src/db";
import { hasUnfinishedApplyCycle } from "../src/handlers/runApplyCycle";
import * as schema from "../../src/db/schema";

async function main() {
  const cfg = getConfig();
  const ownerUserId = cfg.WORKER_OWNER_USER_ID;
  if (!ownerUserId) {
    throw new Error("WORKER_OWNER_USER_ID must be set to enqueue an apply cycle.");
  }

  if (await hasUnfinishedApplyCycle(ownerUserId)) {
    throw new Error("An unfinished run_apply_cycle already exists for this user.");
  }

  const database = getWorkerDb();
  const [command] = await database
    .insert(schema.commands)
    .values({
      type: "run_apply_cycle",
      source: "system",
      requestedBy: ownerUserId,
      payloadJson: { phase: "discover" },
      priority: "normal",
      scheduledFor: new Date(),
    })
    .returning();
  if (!command) throw new Error("Failed to create run_apply_cycle command.");

  await database.insert(schema.commandEvents).values({
    commandId: command.id,
    eventType: "created",
    message: "Apply cycle enqueued by worker:cycle.",
    metadataJson: { requestedBy: ownerUserId, source: "system" },
  });

  console.log(JSON.stringify({ ok: true, commandId: command.id }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
