import { ApiError, handleApi, jsonOk } from "@/lib/api";
import { requireScopedSecret } from "@/lib/security";
import { getJobDetail } from "@/services/jobs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleApi(async () => {
    requireScopedSecret(request, "EXTENSION_API_SECRET");
    const job = await getJobDetail((await params).id);
    if (!job) throw new ApiError(404, "NOT_FOUND", "Job not found.");

    return jsonOk({
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      source: job.source,
      sourceUrl: job.sourceUrl,
      description: job.description,
      salaryText: job.salaryText,
      employmentType: job.employmentType,
      remoteType: job.remoteType,
      status: job.status,
      fitScore: job.fitScore,
      priority: job.priority,
      visaSignal: job.visaSignal,
      techStack: job.techStack,
      notes: job.notes,
      reviews: job.reviews,
    });
  });
}
