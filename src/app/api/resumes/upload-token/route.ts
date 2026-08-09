import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { resumeVersions } from "@/db/schema";
import { requireDashboardUser } from "@/lib/auth";
import {
  RESUME_ALLOWED_MIME_TYPES,
  RESUME_MAX_BYTES,
} from "@/lib/resumeHealth";

export const runtime = "nodejs";

const tokenMetaSchema = z
  .object({
    userId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    sha256: z.string().trim().regex(/^[a-f0-9]{64}$/i),
    originalFilename: z.string().trim().min(1).max(300),
    mimeType: z.enum(RESUME_ALLOWED_MIME_TYPES),
    sizeBytes: z.number().int().positive().max(RESUME_MAX_BYTES),
  })
  .strict();

const clientPayloadSchema = tokenMetaSchema.omit({ userId: true });

async function persistResumeVersion(meta: z.infer<typeof tokenMetaSchema>, pathname: string) {
  await getDb()
    .insert(resumeVersions)
    .values({
      userId: meta.userId,
      name: meta.name,
      blobPathname: pathname,
      originalFilename: meta.originalFilename,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      sha256: meta.sha256.toLowerCase(),
      storagePath: null,
      isDefault: false,
    })
    .onConflictDoNothing({
      target: [resumeVersions.userId, resumeVersions.sha256],
    });
}

export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: { message: "BLOB_READ_WRITE_TOKEN is not configured." } },
      { status: 503 },
    );
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Auth only for token issuance — upload-completed webhooks have no Clerk session.
        const user = await requireDashboardUser();
        const payload = clientPayloadSchema.parse(
          clientPayload ? JSON.parse(clientPayload) : {},
        );
        if (!pathname.startsWith(`resumes/${user.id}/`)) {
          throw new Error("Resume pathname must be scoped to the signed-in user.");
        }
        return {
          allowedContentTypes: [...RESUME_ALLOWED_MIME_TYPES],
          maximumSizeInBytes: RESUME_MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            userId: user.id,
            name: payload.name,
            sha256: payload.sha256.toLowerCase(),
            originalFilename: payload.originalFilename,
            mimeType: payload.mimeType,
            sizeBytes: payload.sizeBytes,
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const meta = tokenMetaSchema.parse(
          tokenPayload ? JSON.parse(tokenPayload) : {},
        );
        await persistResumeVersion(meta, blob.pathname);
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload token failed.";
    return NextResponse.json({ error: { message } }, { status: 400 });
  }
}
