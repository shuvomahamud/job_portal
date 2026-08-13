import { requireDashboardUser } from "@/lib/auth";
import { ApiError, handleApi, jsonOk } from "@/lib/api";
import { jobsQuerySchema } from "@/lib/validation";
import { deleteJobsMatching, listJobs } from "@/services/jobs";

export async function GET(request: Request) {
  return handleApi(async () => {
    const user = await requireDashboardUser();
    const url = new URL(request.url);
    const query = jobsQuerySchema.parse(Object.fromEntries(url.searchParams));
    return jsonOk(await listJobs(query, user.id));
  });
}

export async function DELETE(request: Request) {
  return handleApi(async () => {
    const user = await requireDashboardUser();
    const url = new URL(request.url);
    const query = jobsQuerySchema.parse(Object.fromEntries(url.searchParams));
    const hasExplicitFilter = Boolean(
      query.status ||
        query.source ||
        query.company ||
        query.search ||
        query.minScore !== undefined,
    );
    if (!hasExplicitFilter && query.visibility === "all") {
      throw new ApiError(
        400,
        "FILTER_REQUIRED",
        "Add at least one filter before deleting jobs in bulk.",
      );
    }
    const deleted = await deleteJobsMatching(query, user.id);
    return jsonOk({
      deletedCount: deleted.length,
      ids: deleted.map((job) => job.id),
    });
  });
}
