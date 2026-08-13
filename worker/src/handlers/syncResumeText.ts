import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../../../src/db/schema";
import { getConfig } from "../config";
import { addCommandEvent, getWorkerDb, upsertCandidateFacts } from "../db";
import { logger } from "../logger";
import { requireCommandUserId } from "../requireCommandUserId";
import type { HandlerContext, HandlerResult } from "../types";
import { extractResumeText } from "../resume/extractText";
import { extractResumeFacts } from "../resume/extractFacts";
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
  const factKeys: string[] = [];
  const cfg = getConfig();

  for (const row of rows) {
    if (context.claimGuard.lost) break;
    try {
      if (!row.storagePath) {
        throw new Error("This resume has no file. Add it again in JobAgent.");
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

      // Facts are a bonus on top of the text sync. A local model that is down or slow
      // must never fail the resume sync itself, so this is best-effort.
      try {
        const facts = await extractResumeFacts(text, {
          ollamaBaseUrl: cfg.OLLAMA_BASE_URL,
          ollamaAllowedRemoteHosts: cfg.ollamaAllowedRemoteHosts,
          ollamaRequestTimeoutMs: cfg.OLLAMA_REQUEST_TIMEOUT_MS,
          ollamaKeepAlive: cfg.OLLAMA_KEEP_ALIVE,
          model: cfg.OLLAMA_MODEL,
        });
        const written = await upsertCandidateFacts({
          userId,
          resumeVersionId: row.id,
          facts,
        });
        factKeys.push(...written);
        await addCommandEvent(
          context.command.id,
          "resume_facts_extracted",
          `Stored ${written.length} resume fact(s) for form filling and matching.`,
          { resumeVersionId: row.id, factKeys: written, skipped: facts.length - written.length },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown fact extraction error";
        logger.warn("Resume fact extraction failed; text sync still succeeded", {
          resumeVersionId: row.id,
          error: message,
        });
        await addCommandEvent(
          context.command.id,
          "resume_facts_extraction_failed",
          "Resume fact extraction failed; resume text was still saved.",
          { resumeVersionId: row.id, error: message },
        );
      }
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
    factKeys: [...new Set(factKeys)],
    claimLost: context.claimGuard.lost,
  };
}
