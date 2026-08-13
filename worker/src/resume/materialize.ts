import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { getWorkerDb } from "../db";

async function sha256File(absolutePath: string): Promise<string> {
  const bytes = await readFile(absolutePath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolves a resume version to a file on disk.
 *
 * Resumes are stored locally by the JobAgent app, so there is nothing to download: the row
 * already records an absolute path. The recorded hash is re-checked so a file that was
 * swapped or truncated after being added is caught here rather than being submitted to an
 * employer.
 */
export async function materializeResume(
  versionId: string,
): Promise<{ absolutePath: string; sha256: string }> {
  const [resume] = await getWorkerDb()
    .select()
    .from(schema.resumeVersions)
    .where(eq(schema.resumeVersions.id, versionId))
    .limit(1);

  if (!resume) throw new Error(`Resume version ${versionId} was not found.`);
  if (!resume.storagePath) {
    throw new Error(
      `Resume version ${versionId} has no stored file. Add it again in the JobAgent app.`,
    );
  }

  const localHash = await sha256File(resume.storagePath).catch(() => null);
  if (!localHash) {
    throw new Error(`Resume file is missing at ${resume.storagePath}. Re-add it in JobAgent.`);
  }
  if (resume.sha256 && localHash !== resume.sha256) {
    throw new Error(
      `Resume file at ${resume.storagePath} changed since it was added. Re-add it in JobAgent.`,
    );
  }

  return { absolutePath: resume.storagePath, sha256: localHash };
}
