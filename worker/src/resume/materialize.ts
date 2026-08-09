import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/db/schema";
import { requestResumeDownloadUrl } from "../dashboardClient";
import { getWorkerDb } from "../db";

function cacheRoot() {
  return join(homedir(), ".job-portal", "resumes");
}

function extensionFor(mimeType: string | null, originalFilename: string | null) {
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return ".docx";
  }
  const fromName = originalFilename ? extname(originalFilename).toLowerCase() : "";
  if (fromName === ".pdf" || fromName === ".docx") return fromName;
  return ".bin";
}

async function sha256FileSimple(absolutePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(absolutePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function materializeResume(
  versionId: string,
): Promise<{ absolutePath: string; sha256: string }> {
  const [resume] = await getWorkerDb()
    .select()
    .from(schema.resumeVersions)
    .where(eq(schema.resumeVersions.id, versionId))
    .limit(1);

  if (!resume) throw new Error(`Resume version ${versionId} was not found.`);
  if (!resume.blobPathname || !resume.sha256) {
    throw new Error(`Resume version ${versionId} has no Blob object; re-upload is required.`);
  }

  const ext = extensionFor(resume.mimeType, resume.originalFilename);
  const dir = cacheRoot();
  await mkdir(dir, { recursive: true });
  const absolutePath = join(dir, `${versionId}${ext}`);

  try {
    const existing = await sha256FileSimple(absolutePath);
    if (existing === resume.sha256) {
      return { absolutePath, sha256: existing };
    }
    await unlink(absolutePath).catch(() => undefined);
  } catch {
    // cache miss
  }

  const download = await requestResumeDownloadUrl(versionId);
  if (download.sha256 !== resume.sha256) {
    throw new Error(`Resume download metadata sha256 mismatch for ${versionId}.`);
  }

  const response = await fetch(download.downloadUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Resume download failed with HTTP ${response.status}.`);
  }

  const tempPath = join(dir, `${versionId}.${Date.now()}.tmp`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tempPath));

  const downloadedHash = await sha256FileSimple(tempPath);
  if (downloadedHash !== resume.sha256) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(
      `Resume sha256 mismatch for ${versionId}: expected ${resume.sha256}, got ${downloadedHash}.`,
    );
  }

  await rename(tempPath, absolutePath);
  return { absolutePath, sha256: downloadedHash };
}
