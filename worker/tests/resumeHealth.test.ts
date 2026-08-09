import assert from "node:assert/strict";
import test from "node:test";
import {
  isResumeHealthyForActivation,
  resumeHealthLabel,
} from "../../src/lib/resumeHealth";

test("resume health requires blob, extraction, and enough characters", () => {
  assert.equal(
    isResumeHealthyForActivation({
      blobPathname: null,
      resumeTextChars: 2000,
      extractionError: null,
      textExtractedAt: new Date(),
    }),
    false,
  );
  assert.equal(
    isResumeHealthyForActivation({
      blobPathname: "resumes/u/a.pdf",
      resumeTextChars: 200,
      extractionError: null,
      textExtractedAt: new Date(),
    }),
    false,
  );
  assert.equal(
    isResumeHealthyForActivation({
      blobPathname: "resumes/u/a.pdf",
      resumeTextChars: 1200,
      extractionError: null,
      textExtractedAt: new Date(),
    }),
    true,
  );
  assert.match(
    resumeHealthLabel({
      blobPathname: null,
      storagePath: "/old/local/resume.pdf",
      resumeTextChars: 2000,
      extractionError: null,
      textExtractedAt: new Date(),
    }),
    /Legacy local path/,
  );
});
