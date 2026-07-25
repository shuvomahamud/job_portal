import { requireDashboardUser } from "@/lib/auth";
import { handleApi, jsonOk } from "@/lib/api";
import { jobsQuerySchema } from "@/lib/validation";
import { listJobs } from "@/services/jobs";

export async function GET(request: Request) {
  return handleApi(async () => {
    await requireDashboardUser();
    const url = new URL(request.url);
    const query = jobsQuerySchema.parse(Object.fromEntries(url.searchParams));
    return jsonOk(await listJobs(query));
  });
}
