import { eq } from "drizzle-orm";
import { z } from "zod";
import { issueSignedToken, presignUrl } from "@vercel/blob";
import { ApiError, handleApi, jsonOk, parseJson } from "@/lib/api";
import { requireScopedSecret } from "@/lib/security";
import { getDb } from "@/db";
import { resumeVersions } from "@/db/schema";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    resumeVersionId: z.uuid(),
  })
  .strict();

export async function POST(request: Request) {
  return handleApi(async () => {
    requireScopedSecret(request, "WORKER_API_SECRET");
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new ApiError(
        503,
        "INTEGRATION_NOT_CONFIGURED",
        "BLOB_READ_WRITE_TOKEN is not configured.",
      );
    }

    const { resumeVersionId } = bodySchema.parse(await parseJson(request));
    const [resume] = await getDb()
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, resumeVersionId))
      .limit(1);

    if (!resume?.blobPathname || !resume.sha256) {
      throw new ApiError(404, "NOT_FOUND", "Resume version has no private Blob object.");
    }

    const validUntil = Date.now() + 5 * 60 * 1000;
    const signed = await issueSignedToken({
      token: process.env.BLOB_READ_WRITE_TOKEN,
      pathname: resume.blobPathname,
      operations: ["get"],
      validUntil,
    });
    const { presignedUrl } = await presignUrl(signed, {
      access: "private",
      operation: "get",
      pathname: resume.blobPathname,
      validUntil,
      useCache: false,
    });

    return jsonOk({
      resumeVersionId: resume.id,
      pathname: resume.blobPathname,
      sha256: resume.sha256,
      mimeType: resume.mimeType,
      originalFilename: resume.originalFilename,
      downloadUrl: presignedUrl,
      expiresAt: new Date(validUntil).toISOString(),
    });
  });
}
