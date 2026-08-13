import { sql } from "drizzle-orm";
import { getConfig } from "./config";
import { getWorkerDb } from "./db";
import { supportedPhase2CommandTypes } from "./dispatcher";
import { verifyOllamaHealth } from "./ai/ollamaClient";

async function main() {
  const cfg = getConfig();
  await getWorkerDb().execute(sql`SELECT 1`);
  const commandTypes = cfg.workerCommandTypes.filter((type) => supportedPhase2CommandTypes().includes(type));
  if (commandTypes.includes("run_local_llm_extraction")) {
    await verifyOllamaHealth({
      baseUrl: cfg.OLLAMA_BASE_URL,
      allowedRemoteHosts: cfg.ollamaAllowedRemoteHosts,
      model: cfg.OLLAMA_MODEL,
      requestTimeoutMs: cfg.OLLAMA_REQUEST_TIMEOUT_MS,
      keepAlive: cfg.OLLAMA_KEEP_ALIVE,
    });
  }
  if (cfg.JOB_BROWSER_CDP_URL) {
    const versionUrl = new URL("/json/version", cfg.JOB_BROWSER_CDP_URL);
    const response = await fetch(versionUrl, {
      signal: AbortSignal.timeout(cfg.JOB_BROWSER_CDP_CONNECT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Dedicated Chrome CDP health check failed with HTTP ${response.status}.`);
    }
  }
  console.log(JSON.stringify({
    ok: true,
    workerId: cfg.WORKER_ID,
    dashboardBaseUrl: cfg.DASHBOARD_BASE_URL,
    pollIntervalSeconds: cfg.WORKER_POLL_INTERVAL_SECONDS,
    commandTypes,
    browserChannel: cfg.JOB_BROWSER_CHANNEL ?? "bundled",
    browserHeadless: cfg.JOB_BROWSER_HEADLESS,
    browserConnection: cfg.JOB_BROWSER_CDP_URL ? "attached_cdp" : "playwright_launched",
    browserCdpUrl: cfg.JOB_BROWSER_CDP_URL ?? null,
    ollamaModel: commandTypes.includes("run_local_llm_extraction") ? cfg.OLLAMA_MODEL : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, null, 2));
  process.exit(1);
});
