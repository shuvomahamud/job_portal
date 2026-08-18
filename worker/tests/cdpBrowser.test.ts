import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareManagedCdpBrowser,
  validateManagedCdpEndpoint,
  type CdpTarget,
} from "../src/search/cdpBrowser";

test("managed CDP cleanup is restricted to loopback endpoints", () => {
  assert.equal(validateManagedCdpEndpoint("http://127.0.0.1:9222").hostname, "127.0.0.1");
  assert.equal(validateManagedCdpEndpoint("http://localhost:9222").hostname, "localhost");
  assert.throws(
    () => validateManagedCdpEndpoint("http://browser.example.com:9222"),
    /restricted to a loopback/i,
  );
});

test("managed CDP cleanup creates a fresh tab and keeps live apply pages", async () => {
  const targets = new Map<string, CdpTarget>([
    ["old-indeed", { id: "old-indeed", type: "page", url: "https://smartapply.indeed.com/beta/indeedapply/form/questions-module/questions/1" }],
    ["old-blank", { id: "old-blank", type: "page", url: "about:blank" }],
    ["service-worker", { id: "service-worker", type: "service_worker", url: "https://example.com/sw.js" }],
  ]);
  const requests: Array<{ method: string; url: string }> = [];

  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, url: url.toString() });

    if (url.pathname === "/json/list") {
      return Response.json([...targets.values()]);
    }
    if (url.pathname === "/json/new" && method === "PUT") {
      const fresh = { id: "fresh-blank", type: "page", url: "about:blank" };
      targets.set(fresh.id, fresh);
      return Response.json(fresh);
    }
    if (url.pathname.startsWith("/json/close/")) {
      targets.delete(decodeURIComponent(url.pathname.slice("/json/close/".length)));
      return new Response("Target is closing");
    }
    return new Response("Not found", { status: 404 });
  };

  const result = await prepareManagedCdpBrowser("http://127.0.0.1:9222", {
    fetchImpl,
    requestTimeoutMs: 1_000,
    settleTimeoutMs: 1_000,
  });

  assert.deepEqual(result, {
    freshTargetId: "fresh-blank",
    closedTargetIds: ["old-blank"],
  });
  assert.deepEqual([...targets.keys()].sort(), ["fresh-blank", "old-indeed", "service-worker"]);
  assert.equal(requests.some((request) => request.method === "PUT" && request.url.includes("/json/new?")), true);
  assert.equal(requests.some((request) => request.url.endsWith("/json/close/old-indeed")), false);
  assert.equal(requests.some((request) => request.url.endsWith("/json/close/old-blank")), true);
  assert.equal(requests.some((request) => request.url.endsWith("/json/close/service-worker")), false);
});
