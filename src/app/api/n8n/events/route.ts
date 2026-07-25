import { getDb } from "@/db";
import { integrationEvents } from "@/db/schema";
import { handleApi, jsonOk, parseJson } from "@/lib/api";
import { requireScopedSecret } from "@/lib/security";
import { n8nEventSchema } from "@/lib/validation";

export async function POST(request: Request) {
  return handleApi(async () => {
    requireScopedSecret(request, "N8N_WEBHOOK_SECRET");
    const input = n8nEventSchema.parse(await parseJson(request));
    const [event] = await getDb()
      .insert(integrationEvents)
      .values({
        source: "n8n",
        eventType: input.eventType,
        payloadJson: input.payloadJson,
      })
      .returning();
    return jsonOk(event, 202);
  });
}
