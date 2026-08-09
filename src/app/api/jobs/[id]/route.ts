import { requireDashboardUser } from "@/lib/auth";
import { ApiError, handleApi, jsonOk, parseJson } from "@/lib/api";
import { jobUpdateSchema } from "@/lib/validation";
import { deleteJob, getJobDetail, updateJob } from "@/services/jobs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_: Request, context: RouteContext) {
  return handleApi(async () => {
    const user = await requireDashboardUser();
    const { id } = await context.params;
    const job = await getJobDetail(id, user.id);
    if (!job) throw new ApiError(404, "NOT_FOUND", "Job not found.");
    return jsonOk(job);
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return handleApi(async () => {
    await requireDashboardUser();
    const { id } = await context.params;
    const input = jobUpdateSchema.parse(await parseJson(request));
    const job = await updateJob(id, input);
    if (!job) throw new ApiError(404, "NOT_FOUND", "Job not found.");
    return jsonOk(job);
  });
}

export async function DELETE(_: Request, context: RouteContext) {
  return handleApi(async () => {
    await requireDashboardUser();
    const { id } = await context.params;
    const job = await deleteJob(id);
    if (!job) throw new ApiError(404, "NOT_FOUND", "Job not found.");
    return jsonOk({ id: job.id });
  });
}
