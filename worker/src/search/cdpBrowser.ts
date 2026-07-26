export type CdpTarget = {
  id: string;
  type: string;
  title?: string;
  url?: string;
};

export type CdpCleanupResult = {
  freshTargetId: string;
  closedTargetIds: string[];
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export async function prepareManagedCdpBrowser(
  endpointUrl: string,
  options: {
    fetchImpl?: FetchLike;
    requestTimeoutMs?: number;
    settleTimeoutMs?: number;
  } = {},
): Promise<CdpCleanupResult> {
  const endpoint = validateManagedCdpEndpoint(endpointUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const settleTimeoutMs = options.settleTimeoutMs ?? 10_000;

  const targetsBefore = await listTargets(endpoint, fetchImpl, requestTimeoutMs);
  const freshTarget = await createBlankTarget(endpoint, fetchImpl, requestTimeoutMs);
  const targetsToClose = targetsBefore.filter(
    (target) => target.type === "page" && target.id !== freshTarget.id,
  );

  await Promise.all(
    targetsToClose.map((target) =>
      request(
        new URL(`/json/close/${encodeURIComponent(target.id)}`, endpoint),
        fetchImpl,
        requestTimeoutMs,
      ),
    ),
  );

  await waitForManagedTargetOnly(
    endpoint,
    freshTarget.id,
    fetchImpl,
    requestTimeoutMs,
    settleTimeoutMs,
  );

  return {
    freshTargetId: freshTarget.id,
    closedTargetIds: targetsToClose.map((target) => target.id),
  };
}

export function validateManagedCdpEndpoint(endpointUrl: string) {
  const endpoint = new URL(endpointUrl);
  if (!["http:", "https:"].includes(endpoint.protocol) || !LOOPBACK_HOSTS.has(endpoint.hostname)) {
    throw new Error(
      "Managed CDP cleanup is restricted to a loopback HTTP endpoint so it cannot close tabs in a remote or shared browser.",
    );
  }
  return endpoint;
}

async function listTargets(
  endpoint: URL,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<CdpTarget[]> {
  const response = await request(new URL("/json/list", endpoint), fetchImpl, timeoutMs);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("Chrome CDP /json/list returned an invalid response.");
  return body.filter(isCdpTarget);
}

async function createBlankTarget(
  endpoint: URL,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<CdpTarget> {
  const url = new URL("/json/new", endpoint);
  url.search = encodeURIComponent("about:blank");
  const response = await request(url, fetchImpl, timeoutMs, { method: "PUT" });
  const body: unknown = await response.json();
  if (!isCdpTarget(body) || body.type !== "page") {
    throw new Error("Chrome CDP could not create a fresh blank page.");
  }
  return body;
}

async function waitForManagedTargetOnly(
  endpoint: URL,
  freshTargetId: string,
  fetchImpl: FetchLike,
  requestTimeoutMs: number,
  settleTimeoutMs: number,
) {
  const deadlineAt = Date.now() + settleTimeoutMs;
  while (true) {
    const pageTargets = (await listTargets(endpoint, fetchImpl, requestTimeoutMs))
      .filter((target) => target.type === "page");
    if (pageTargets.length === 1 && pageTargets[0]?.id === freshTargetId) return;
    if (Date.now() >= deadlineAt) {
      throw new Error("Chrome CDP cleanup timed out while waiting for stale pages to close.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function request(
  url: URL,
  fetchImpl: FetchLike,
  timeoutMs: number,
  init: RequestInit = {},
) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Chrome CDP request failed (${response.status}) for ${url.pathname}.`);
  }
  return response;
}

function isCdpTarget(value: unknown): value is CdpTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<CdpTarget>;
  return typeof target.id === "string" && typeof target.type === "string";
}
