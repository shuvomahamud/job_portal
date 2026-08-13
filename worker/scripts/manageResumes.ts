/**
 * Resume management for the JobAgent app.
 *
 * The app is a Swift process with no database driver, so it shells out to this script and
 * parses the JSON on stdout. Human-readable progress goes to stderr so it never corrupts
 * the payload.
 *
 *   tsx worker/scripts/manageResumes.ts list
 *   tsx worker/scripts/manageResumes.ts add /path/to/resume.pdf --name "Senior .NET"
 *   tsx worker/scripts/manageResumes.ts remove <resumeVersionId>
 *   tsx worker/scripts/manageResumes.ts default <resumeVersionId>
 *
 * Requires DATABASE_URL and WORKER_OWNER_USER_ID.
 */
import { basename } from "node:path";
import { config as loadEnv } from "dotenv";
import { and, desc, eq, ne } from "drizzle-orm";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.local", quiet: true });
loadEnv({ path: process.env.WORKER_ENV_FILE || ".env", quiet: true });

import * as schema from "../../src/db/schema";
import { extractResumeText } from "../src/resume/extractText";
import { removeResumeFile, storeResumeFile } from "../src/resume/localStore";
import { getScriptDb as getWorkerDb } from "../src/scriptDb";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerUserId(): string {
  const value = process.env.WORKER_OWNER_USER_ID?.trim();
  if (!value) {
    throw new Error("WORKER_OWNER_USER_ID is not set. Add your user ID in JobAgent settings.");
  }
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`WORKER_OWNER_USER_ID is not a valid UUID: ${value}`);
  }
  return value;
}

function log(message: string) {
  process.stderr.write(`${message}\n`);
}

async function list() {
  const rows = await getWorkerDb()
    .select()
    .from(schema.resumeVersions)
    .where(eq(schema.resumeVersions.userId, ownerUserId()))
    .orderBy(desc(schema.resumeVersions.isDefault), desc(schema.resumeVersions.createdAt));

  return {
    resumes: rows.map((row) => ({
      id: row.id,
      name: row.name,
      originalFilename: row.originalFilename,
      storagePath: row.storagePath,
      sizeBytes: row.sizeBytes,
      isDefault: row.isDefault,
      resumeTextChars: row.resumeTextChars,
      extractionError: row.extractionError,
      textExtractedAt: row.textExtractedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

async function add(sourcePath: string, explicitName: string | null) {
  const userId = ownerUserId();
  const database = getWorkerDb();

  log(`Copying ${basename(sourcePath)} into the JobAgent resume store…`);
  const stored = await storeResumeFile(sourcePath);

  log("Extracting text…");
  let resumeText: string | null = null;
  let resumeTextChars: number | null = null;
  let extractionError: string | null = null;
  try {
    const extracted = await extractResumeText(stored.storagePath);
    resumeText = extracted.text;
    resumeTextChars = extracted.chars;
    log(`Extracted ${extracted.chars} characters from the ${extracted.kind.toUpperCase()}.`);
  } catch (error) {
    extractionError = error instanceof Error ? error.message : "Unknown extraction error";
    log(`Text extraction failed: ${extractionError}`);
  }

  const name = explicitName?.trim() || basename(sourcePath).replace(/\.[^.]+$/, "");

  // resume_versions is unique on (user_id, sha256), so re-adding the same file updates the
  // existing row rather than failing or creating a duplicate.
  const [existing] = await database
    .select()
    .from(schema.resumeVersions)
    .where(
      and(
        eq(schema.resumeVersions.userId, userId),
        eq(schema.resumeVersions.sha256, stored.sha256),
      ),
    )
    .limit(1);

  const fields = {
    name,
    storagePath: stored.storagePath,
    originalFilename: basename(sourcePath),
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    resumeText,
    resumeTextChars,
    textExtractedAt: resumeText ? new Date() : null,
    extractionError,
    updatedAt: new Date(),
  };

  let resumeId: string;
  if (existing) {
    log("A resume with identical contents already exists; updating it.");
    await removeResumeFile(existing.storagePath === stored.storagePath ? null : existing.storagePath);
    await database
      .update(schema.resumeVersions)
      .set(fields)
      .where(eq(schema.resumeVersions.id, existing.id));
    resumeId = existing.id;
  } else {
    const [inserted] = await database
      .insert(schema.resumeVersions)
      .values({ userId, isDefault: false, ...fields })
      .returning({ id: schema.resumeVersions.id });
    resumeId = inserted.id;
  }

  // First resume becomes the default so a role always has something to select.
  const [{ count } = { count: 0 }] = await database
    .select({ count: schema.resumeVersions.id })
    .from(schema.resumeVersions)
    .where(eq(schema.resumeVersions.userId, userId))
    .limit(2)
    .then((rows) => [{ count: rows.length }]);
  if (count === 1) {
    await database
      .update(schema.resumeVersions)
      .set({ isDefault: true })
      .where(eq(schema.resumeVersions.id, resumeId));
  }

  return { id: resumeId, name, chars: resumeTextChars, extractionError };
}

async function remove(resumeId: string) {
  const userId = ownerUserId();
  const database = getWorkerDb();

  const [row] = await database
    .select()
    .from(schema.resumeVersions)
    .where(and(eq(schema.resumeVersions.userId, userId), eq(schema.resumeVersions.id, resumeId)))
    .limit(1);
  if (!row) throw new Error("That resume was not found.");

  try {
    await database.delete(schema.resumeVersions).where(eq(schema.resumeVersions.id, resumeId));
  } catch (error) {
    // target_roles.resume_version_id is ON DELETE RESTRICT.
    const message = error instanceof Error ? error.message : String(error);
    if (/foreign key|violates/i.test(message)) {
      throw new Error("This resume is still selected by a role. Point that role at another resume first.");
    }
    throw error;
  }

  await removeResumeFile(row.storagePath);
  return { removed: resumeId };
}

async function setDefault(resumeId: string) {
  const userId = ownerUserId();
  const database = getWorkerDb();

  const [row] = await database
    .select()
    .from(schema.resumeVersions)
    .where(and(eq(schema.resumeVersions.userId, userId), eq(schema.resumeVersions.id, resumeId)))
    .limit(1);
  if (!row) throw new Error("That resume was not found.");

  await database
    .update(schema.resumeVersions)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(schema.resumeVersions.userId, userId), ne(schema.resumeVersions.id, resumeId)));
  await database
    .update(schema.resumeVersions)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(eq(schema.resumeVersions.id, resumeId));

  return { default: resumeId };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const nameIndex = rest.indexOf("--name");
  const explicitName = nameIndex >= 0 ? rest[nameIndex + 1] ?? null : null;
  // Guard on nameIndex >= 0: without it, an absent --name makes nameIndex + 1 equal 0 and
  // the filter drops the first real argument.
  const positional =
    nameIndex >= 0
      ? rest.filter((_, index) => index !== nameIndex && index !== nameIndex + 1)
      : rest;

  switch (command) {
    case "list":
      return list();
    case "add": {
      if (!positional[0]) throw new Error("Usage: manageResumes.ts add <file> [--name \"...\"]");
      return add(positional[0], explicitName);
    }
    case "remove": {
      if (!positional[0]) throw new Error("Usage: manageResumes.ts remove <resumeVersionId>");
      return remove(positional[0]);
    }
    case "default": {
      if (!positional[0]) throw new Error("Usage: manageResumes.ts default <resumeVersionId>");
      return setDefault(positional[0]);
    }
    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}. Use list, add, remove or default.`);
  }
}

main()
  .then((result) => {
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    log(message);
    process.exit(1);
  });
