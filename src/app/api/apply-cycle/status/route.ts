import { requireDashboardUser } from "@/lib/auth";
import { handleApi, jsonOk } from "@/lib/api";
import { getApplyCycleStatus } from "@/services/applyCycle";

export async function GET() {
  return handleApi(async () => {
    const user = await requireDashboardUser();
    return jsonOk(await getApplyCycleStatus(user.id));
  });
}
