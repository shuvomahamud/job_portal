import { requireDashboardUser } from "@/lib/auth";
import { handleApi, jsonOk, parseJson } from "@/lib/api";
import { jobImportSchema } from "@/lib/validation";
import { importJob } from "@/services/jobs";

export async function POST(request: Request) {
  return handleApi(async () => {
    await requireDashboardUser();
    const input = jobImportSchema.parse(await parseJson(request));
    const job = await importJob(input);
    return jsonOk(job, 201);
  });
}
