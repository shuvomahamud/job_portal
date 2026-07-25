import { handleApi, jsonOk, parseJson } from "@/lib/api";
import { requireScopedSecret } from "@/lib/security";
import { workerFailSchema } from "@/lib/validation";
import { failCommand } from "@/services/commands";

export async function POST(request: Request) {
  return handleApi(async () => {
    requireScopedSecret(request, "WORKER_API_SECRET");
    const input = workerFailSchema.parse(await parseJson(request));
    return jsonOk(
      await failCommand(
        input.commandId,
        input.workerId,
        input.errorMessage,
        input.resultJson,
      ),
    );
  });
}
