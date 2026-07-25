import "server-only";
import { ApiError } from "./api";
import { constantTimeSecretEquals } from "./security-core";

export type ScopedSecret =
  | "HERMES_COMMAND_SECRET"
  | "WORKER_API_SECRET"
  | "N8N_WEBHOOK_SECRET"
  | "EXTENSION_API_SECRET";

const scopedHeaders: Record<ScopedSecret, string> = {
  HERMES_COMMAND_SECRET: "x-hermes-command-secret",
  WORKER_API_SECRET: "x-worker-api-secret",
  N8N_WEBHOOK_SECRET: "x-n8n-webhook-secret",
  EXTENSION_API_SECRET: "x-extension-api-secret",
};

function suppliedSecret(request: Request, scope: ScopedSecret) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.headers.get(scopedHeaders[scope])?.trim() ?? null;
}

export function isValidScopedSecret(request: Request, scope: ScopedSecret) {
  const expected = process.env[scope];
  const supplied = suppliedSecret(request, scope);
  if (!expected || !supplied) return false;

  return constantTimeSecretEquals(expected, supplied);
}

export function requireScopedSecret(request: Request, scope: ScopedSecret) {
  if (!process.env[scope]) {
    throw new ApiError(
      503,
      "INTEGRATION_NOT_CONFIGURED",
      `${scope} is not configured.`,
    );
  }
  if (!isValidScopedSecret(request, scope)) {
    throw new ApiError(
      401,
      "UNAUTHORIZED",
      "A valid scoped integration secret is required.",
    );
  }
}
