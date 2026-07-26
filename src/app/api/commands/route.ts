import { z } from "zod";
import { requireDashboardUser } from "@/lib/auth";
import { handleApi, jsonOk, parseJson } from "@/lib/api";
import {
  COMMAND_STATUSES,
  COMMAND_TYPES,
} from "@/lib/constants";
import {
  isValidScopedSecret,
  requireScopedSecret,
} from "@/lib/security";
import { createCommand, listCommands } from "@/services/commands";

const commandQuerySchema = z.object({
  status: z.enum(COMMAND_STATUSES).optional(),
  type: z.enum(COMMAND_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function POST(request: Request) {
  return handleApi(async () => {
    const hasIntegrationHeader =
      request.headers.has("authorization") ||
      request.headers.has("x-hermes-command-secret");

    let actor: {
      source: "dashboard" | "hermes";
      requestedBy: string;
    };

    if (
      hasIntegrationHeader ||
      isValidScopedSecret(request, "HERMES_COMMAND_SECRET")
    ) {
      requireScopedSecret(request, "HERMES_COMMAND_SECRET");
      actor = { source: "hermes", requestedBy: "hermes" };
    } else {
      const user = await requireDashboardUser();
      actor = { source: "dashboard", requestedBy: user.id };
    }

    const command = await createCommand(await parseJson(request), actor);
    return jsonOk(command, 201);
  });
}

export async function GET(request: Request) {
  return handleApi(async () => {
    const user = await requireDashboardUser();
    const query = commandQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return jsonOk(await listCommands({ ...query, requestedBy: user.id }));
  });
}
