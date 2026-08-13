import { getConfig } from "../src/config";
import { getWorkerDb } from "../src/db";
import { hasUnfinishedApplyCycle } from "../src/handlers/runApplyCycle";
import * as schema from "../../src/db/schema";

const ALL_SOURCES = ["indeed", "dice"] as const;
type Source = (typeof ALL_SOURCES)[number];

/** `--sources dice` or `--sources indeed,dice`. Defaults to every board. */
function parseSources(): Source[] | undefined {
  const index = process.argv.indexOf("--sources");
  if (index < 0) return undefined;
  const raw = process.argv[index + 1];
  if (!raw) throw new Error("--sources needs a value, e.g. --sources dice");

  const requested = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = requested.filter((value) => !ALL_SOURCES.includes(value as Source));
  if (invalid.length) {
    throw new Error(`Unknown source(s): ${invalid.join(", ")}. Valid: ${ALL_SOURCES.join(", ")}`);
  }
  if (!requested.length) throw new Error("--sources needs at least one board.");
  return Array.from(new Set(requested)) as Source[];
}

async function main() {
  // Parsed first so a bad --sources value reports itself plainly instead of being masked
  // by an unrelated worker-config validation error.
  const sources = parseSources();

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
      payloadJson: sources ? { phase: "discover", sources } : { phase: "discover" },
      priority: "normal",
      scheduledFor: new Date(),
    })
    .returning();
  if (!command) throw new Error("Failed to create run_apply_cycle command.");

  await database.insert(schema.commandEvents).values({
    commandId: command.id,
    eventType: "created",
    message: sources
      ? `Apply cycle enqueued by worker:cycle for ${sources.join(", ")}.`
      : "Apply cycle enqueued by worker:cycle.",
    metadataJson: { requestedBy: ownerUserId, source: "system", sources: sources ?? null },
  });

  console.log(JSON.stringify({ ok: true, commandId: command.id, sources: sources ?? ALL_SOURCES }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
