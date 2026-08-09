import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { handleApi, jsonOk, parseJson } from "@/lib/api";
import { requireDashboardUser } from "@/lib/auth";
import {
  RESUME_ALLOWED_MIME_TYPES,
  RESUME_MAX_BYTES,
} from "@/lib/resumeHealth";
import { getDb } from "@/db";
import { resumeVersions } from "@/db/schema";

export const runtime = "nodejs";

const completeSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    blobPathname: z.string().trim().min(1).max(1_000),
    originalFilename: z.string().trim().min(1).max(300),
    mimeType: z.enum(RESUME_ALLOWED_MIME_TYPES),
    sizeBytes: z.number().int().positive().max(RESUME_MAX_BYTES),
    sha256: z.string().trim().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

/** Client-side completion callback — reliable in local dev when Blob webhooks do not fire. */
export async function POST(request: Request) {
  return handleApi(async () => {
    const user = await requireDashboardUser();
    const input = completeSchema.parse(await parseJson(request));
    if (!input.blobPathname.startsWith(`resumes/${user.id}/`)) {
      throw new Error("Resume pathname must be scoped to the signed-in user.");
    }

    const database = getDb();
    const [inserted] = await database
      .insert(resumeVersions)
      .values({
        userId: user.id,
        name: input.name,
        blobPathname: input.blobPathname,
        originalFilename: input.originalFilename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256.toLowerCase(),
        storagePath: null,
        isDefault: false,
      })
      .onConflictDoNothing({
        target: [resumeVersions.userId, resumeVersions.sha256],
      })
      .returning();

    const row = inserted ?? (await database
      .select()
      .from(resumeVersions)
      .where(
        and(
          eq(resumeVersions.userId, user.id),
          eq(resumeVersions.sha256, input.sha256.toLowerCase()),
        ),
      )
      .limit(1))[0];

    if (!row) {
      throw new Error("Could not persist resume metadata.");
    }

    return jsonOk({ resume: row }, 201);
  });
}
