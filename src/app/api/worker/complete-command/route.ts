import { handleApi, jsonOk, parseJson } from "@/lib/api";
import { requireScopedSecret } from "@/lib/security";
import { workerCompleteSchema } from "@/lib/validation";
import { completeCommand } from "@/services/commands";

export async function POST(request: Request) {
  return handleApi(async () => {
    requireScopedSecret(request, "WORKER_API_SECRET");
    const input = workerCompleteSchema.parse(await parseJson(request));
    return jsonOk(
      await completeCommand(
        input.commandId,
        input.workerId,
        input.resultJson,
      ),
    );
  });
}
