import { z } from "zod";
import { requireDashboardUser } from "@/lib/auth";
import { handleApi, jsonOk } from "@/lib/api";
import { getMatchingRunForUser } from "@/services/commands";

function safeCommand(command: NonNullable<Awaited<ReturnType<typeof getMatchingRunForUser>>>["root"]) {
  return {
    id: command.id,
    type: command.type,
    status: command.status,
    priority: command.priority,
    createdAt: command.createdAt,
    claimedAt: command.claimedAt,
    completedAt: command.completedAt,
    resultJson: command.resultJson,
    errorMessage: command.errorMessage,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleApi(async () => {
    const user = await requireDashboardUser();
    const { id } = await context.params;
    const run = await getMatchingRunForUser(z.uuid().parse(id), user.id);
    if (!run) return jsonOk({ run: null });
    return jsonOk({ root: safeCommand(run.root), children: run.children.map(safeCommand) });
  });
}
