/**
 * Local resume storage owned by the JobAgent app.
 *
 * Resumes are copied into a directory the app controls rather than referenced where the
 * user happens to have them, so moving or clearing out Downloads cannot break an apply run.
 * The absolute path is recorded on resume_versions.storage_path and read back by
 * materializeResume, which is why no upload to remote storage is involved.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, stat, unlink } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const RESUME_MAX_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Where the app keeps resume files. Overridable so the app can relocate the store. */
export function resumeStoreDir(): string {
  return (
    process.env.JOB_RESUME_STORE_DIR ||
    join(homedir(), "Library", "Application Support", "JobAgent", "Resumes")
  );
}

export function mimeTypeFor(path: string): string | null {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

export async function sha256File(absolutePath: string): Promise<string> {
  const bytes = await readFile(absolutePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export type StoredResumeFile = {
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
};

/**
 * Copies a resume into the managed store. The stored name is a fresh UUID so two files
 * that share a basename cannot collide.
 */
export async function storeResumeFile(sourcePath: string): Promise<StoredResumeFile> {
  const mimeType = mimeTypeFor(sourcePath);
  if (!mimeType) {
    throw new Error(
      `Unsupported resume type: ${extname(sourcePath) || "(no extension)"}. Use a PDF or DOCX file.`,
    );
  }

  const info = await stat(sourcePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`No file at ${sourcePath}`);
  if (info.size > RESUME_MAX_BYTES) {
    throw new Error(`Resume is ${(info.size / 1_048_576).toFixed(1)} MB; the limit is 5 MB.`);
  }

  const dir = resumeStoreDir();
  await mkdir(dir, { recursive: true });

  const extension = extname(sourcePath).toLowerCase();
  const storagePath = join(dir, `${randomUUID()}${extension}`);
  await copyFile(sourcePath, storagePath);

  return {
    storagePath,
    sha256: await sha256File(storagePath),
    sizeBytes: info.size,
    mimeType,
  };
}

export async function removeResumeFile(storagePath: string | null): Promise<void> {
  if (!storagePath) return;
  // A missing file is not an error here: the database row is the thing being removed.
  await unlink(storagePath).catch(() => undefined);
}
