import { handleApi, jsonOk, parseJson } from "@/lib/api";
import { requireScopedSecret } from "@/lib/security";
import { workerClaimSchema } from "@/lib/validation";
import { claimCommand } from "@/services/commands";

export async function POST(request: Request) {
  return handleApi(async () => {
    requireScopedSecret(request, "WORKER_API_SECRET");
    const input = workerClaimSchema.parse(await parseJson(request));
    const command = await claimCommand(input.workerId, input.commandTypes);
    return jsonOk({ command });
  });
}
