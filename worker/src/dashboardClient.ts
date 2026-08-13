import { z } from "zod";
import { getConfig } from "./config";
import type { DashboardCommand } from "./types";

const apiEnvelopeSchema = z.object({ data: z.unknown().optional(), error: z.unknown().optional() });

type RawDashboardCommand = DashboardCommand & {
  requested_by?: string;
  payload_json?: Record<string, unknown>;
  scheduled_for?: string | Date;
  claimed_by?: string | null;
  claimed_at?: string | Date | null;
  completed_at?: string | Date | null;
  result_json?: Record<string, unknown> | null;
  error_message?: string | null;
  created_at?: string | Date;
  updated_at?: string | Date;
};

function normalizeCommand(command: RawDashboardCommand | null | undefined): DashboardCommand | null {
  if (!command) return null;
  return {
    ...command,
    requestedBy: command.requestedBy ?? command.requested_by ?? "unknown",
    payloadJson: command.payloadJson ?? command.payload_json ?? {},
    scheduledFor: command.scheduledFor ?? command.scheduled_for ?? new Date().toISOString(),
    claimedBy: command.claimedBy ?? command.claimed_by ?? null,
    claimedAt: command.claimedAt ?? command.claimed_at ?? null,
    completedAt: command.completedAt ?? command.completed_at ?? null,
    resultJson: command.resultJson ?? command.result_json ?? null,
    errorMessage: command.errorMessage ?? command.error_message ?? null,
    createdAt: command.createdAt ?? command.created_at ?? new Date().toISOString(),
    updatedAt: command.updatedAt ?? command.updated_at ?? new Date().toISOString(),
  };
}

/**
 * Thrown when the dashboard accepted a request but never answered.
 *
 * Worth separating from an ordinary failure: a claim that times out this way has very
 * likely already been recorded server-side, so the command is sitting in `claimed` with
 * nobody running it. Stale-claim recovery releases it, but only if this worker keeps
 * looping rather than dying on the error.
 */
export class DashboardTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`Dashboard did not respond to ${path} within ${timeoutMs}ms.`);
    this.name = "DashboardTimeoutError";
  }
}

async function dashboardRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const cfg = getConfig();
  const timeoutMs = cfg.WORKER_DASHBOARD_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(`${cfg.DASHBOARD_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.WORKER_API_SECRET}`,
      },
      body: JSON.stringify(body),
      // Without this the worker blocks forever on a request the dashboard never finishes,
      // which wedges the whole poll loop — including the stale-claim sweep that would
      // otherwise clean up after it.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new DashboardTimeoutError(path, timeoutMs);
    }
    throw error;
  }
  const json = apiEnvelopeSchema.parse(await response.json().catch(() => ({})));
  if (!response.ok) {
    const err = json.error as { code?: string; message?: string } | undefined;
    throw new Error(`${response.status} ${err?.code ?? "DASHBOARD_ERROR"}: ${err?.message ?? "Dashboard request failed"}`);
  }
  return json.data as T;
}

export async function claimCommand(commandTypes: string[]): Promise<DashboardCommand | null> {
  const cfg = getConfig();
  const data = await dashboardRequest<{ command: RawDashboardCommand | null }>("/api/worker/claim-command", {
    workerId: cfg.WORKER_ID,
    commandTypes,
  });
  return normalizeCommand(data.command);
}

export async function completeCommand(commandId: string, resultJson: Record<string, unknown>) {
  const cfg = getConfig();
  return dashboardRequest<DashboardCommand>("/api/worker/complete-command", {
    commandId,
    workerId: cfg.WORKER_ID,
    resultJson,
  });
}

export async function failCommand(commandId: string, errorMessage: string, resultJson?: Record<string, unknown>) {
  const cfg = getConfig();
  return dashboardRequest<DashboardCommand>("/api/worker/fail-command", {
    commandId,
    workerId: cfg.WORKER_ID,
    errorMessage,
    resultJson,
  });
}
