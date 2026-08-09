import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../../../src/db/schema";
import { addCommandEvent, getWorkerDb } from "../db";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";
import { extractResumeText } from "../resume/extractText";
import { materializeResume } from "../resume/materialize";

const payloadSchema = z
  .object({
    resumeVersionIds: z.array(z.uuid()).min(1).max(50).optional(),
  })
  .strict();

export async function handleSyncResumeText(
  payload: unknown,
  context: HandlerContext,
): Promise<HandlerResult> {
  const userId = requireCommandUserId(context.command.requestedBy);
  const input = payloadSchema.parse(payload ?? {});
  const database = getWorkerDb();

  const rows = input.resumeVersionIds?.length
    ? await database
        .select()
        .from(schema.resumeVersions)
        .where(
          and(
            eq(schema.resumeVersions.userId, userId),
            inArray(schema.resumeVersions.id, input.resumeVersionIds),
          ),
        )
    : await database
        .select()
        .from(schema.resumeVersions)
        .where(
          and(
            eq(schema.resumeVersions.userId, userId),
            isNull(schema.resumeVersions.textExtractedAt),
          ),
        );

  const extracted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const row of rows) {
    if (context.claimGuard.lost) break;
    try {
      if (!row.blobPathname) {
        throw new Error("Legacy resume has no Blob object; re-upload required.");
      }
      const { absolutePath } = await materializeResume(row.id);
      const { text, chars, kind } = await extractResumeText(absolutePath);
      await database
        .update(schema.resumeVersions)
        .set({
          resumeText: text,
          resumeTextChars: chars,
          textExtractedAt: new Date(),
          extractionError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.resumeVersions.id, row.id));
      extracted.push(row.id);
      await addCommandEvent(
        context.command.id,
        "resume_text_extracted",
        `Extracted ${chars} characters from ${kind.toUpperCase()} resume.`,
        { resumeVersionId: row.id, chars, kind },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown extraction error";
      failed.push({ id: row.id, error: message });
      await database
        .update(schema.resumeVersions)
        .set({
          extractionError: message.slice(0, 2_000),
          updatedAt: new Date(),
        })
        .where(eq(schema.resumeVersions.id, row.id));
      await addCommandEvent(
        context.command.id,
        "resume_text_extraction_failed",
        "Resume text extraction failed for one file; continuing.",
        { resumeVersionId: row.id, error: message },
      );
    }
  }

  return {
    scanned: rows.length,
    extractedCount: extracted.length,
    failedCount: failed.length,
    extracted,
    failed,
    claimLost: context.claimGuard.lost,
  };
}
