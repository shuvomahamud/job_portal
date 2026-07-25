import { requireDashboardUser } from "@/lib/auth";
import { handleApi, jsonOk } from "@/lib/api";
import { getDashboardSummary } from "@/services/dashboard";

export async function GET() {
  return handleApi(async () => {
    await requireDashboardUser();
    return jsonOk(await getDashboardSummary());
  });
}
