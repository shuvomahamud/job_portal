import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import { resetConfigCacheForTests } from "../src/config";
import { DashboardTimeoutError, claimCommand } from "../src/dashboardClient";

/** Accepts the request and then never answers, the way a wedged dashboard behaves. */
let silentServer: http.Server;
let baseUrl: string;
/** Held so the socket stays open for the life of the test rather than being closed. */
const openResponses: http.ServerResponse[] = [];

before(async () => {
  silentServer = http.createServer((_request, response) => {
    openResponses.push(response);
  });
  await new Promise<void>((resolve) => silentServer.listen(0, "127.0.0.1", resolve));
  const address = silentServer.address();
  if (typeof address === "string" || !address) throw new Error("Could not bind test server.");
  baseUrl = `http://127.0.0.1:${address.port}`;

  process.env.DATABASE_URL = "postgres://user:pass@127.0.0.1:5432/test";
  process.env.DASHBOARD_BASE_URL = baseUrl;
  process.env.WORKER_API_SECRET = "test-secret-at-least-16-chars";
  process.env.WORKER_DASHBOARD_TIMEOUT_MS = "1000";
  resetConfigCacheForTests();
});

after(async () => {
  for (const response of openResponses) response.destroy();
  await new Promise<void>((resolve) => silentServer.close(() => resolve()));
  resetConfigCacheForTests();
});

test("a dashboard that never answers gives up instead of blocking forever", async () => {
  // The failure this guards: claimCommand sits on the only await in the poll loop, so a
  // request that never returns stops the worker entirely — no further commands, and not
  // even the stale-claim sweep that would release the command the dashboard just claimed.
  const startedAt = Date.now();
  await assert.rejects(
    () => claimCommand(["find_matching_jobs"]),
    (error: unknown) => {
      assert.ok(error instanceof DashboardTimeoutError, `expected a timeout, got ${String(error)}`);
      assert.match((error as Error).message, /claim-command/);
      return true;
    },
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 900, `gave up after only ${elapsed}ms, before the timeout elapsed`);
  assert.ok(elapsed < 10_000, `took ${elapsed}ms, which means the timeout did not apply`);
});
