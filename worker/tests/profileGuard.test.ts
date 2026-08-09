import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApplyProfileComplete,
  isApplyProfileComplete,
} from "../src/apply/profileGuard";
import { extractResumeText } from "../src/resume/extractText";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("assertApplyProfileComplete requires identity fields", () => {
  assert.throws(
    () =>
      assertApplyProfileComplete({
        firstName: null,
        lastName: "Lee",
        phone: "555",
        city: "NYC",
        stateRegion: "NY",
        postalCode: "10001",
        country: "United States",
      }),
    /first_name/,
  );
  assert.equal(
    isApplyProfileComplete({
      firstName: "Jamie",
      lastName: "Lee",
      phone: "555-0100",
      city: "New York",
      stateRegion: "NY",
      postalCode: "10001",
      country: "United States",
    }),
    true,
  );
});

test("extractResumeText reads a minimal DOCX-like failure for unknown types", async () => {
  const dir = join(tmpdir(), "job-portal-resume-tests");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "note.txt");
  await writeFile(path, "hello", "utf8");
  await assert.rejects(() => extractResumeText(path), /Unsupported resume file type/);
});
