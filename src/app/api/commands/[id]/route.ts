import { requireDashboardUser } from "@/lib/auth";
import { ApiError, handleApi, jsonOk } from "@/lib/api";
import { getCommandDetail } from "@/services/commands";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleApi(async () => {
    const user = await requireDashboardUser();
    const command = await getCommandDetail((await params).id, user.id);
    if (!command) throw new ApiError(404, "NOT_FOUND", "Command not found.");
    return jsonOk(command);
  });
}
