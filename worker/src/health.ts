import { sql } from "drizzle-orm";
import { getConfig } from "./config";
import { getWorkerDb } from "./db";
import { supportedPhase2CommandTypes } from "./dispatcher";

async function main() {
  const cfg = getConfig();
  await getWorkerDb().execute(sql`SELECT 1`);
  console.log(JSON.stringify({
    ok: true,
    workerId: cfg.WORKER_ID,
    dashboardBaseUrl: cfg.DASHBOARD_BASE_URL,
    pollIntervalSeconds: cfg.WORKER_POLL_INTERVAL_SECONDS,
    commandTypes: cfg.workerCommandTypes.filter((type) => supportedPhase2CommandTypes().includes(type)),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, null, 2));
  process.exit(1);
});
