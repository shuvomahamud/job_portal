import assert from "node:assert/strict";
import test from "node:test";
import {
  isResumeHealthyForActivation,
  resumeHealthLabel,
} from "../../src/lib/resumeHealth";

test("a resume with no file at all is never healthy", () => {
  const noFile = {
    storagePath: null,
    resumeTextChars: 2000,
    extractionError: null,
    textExtractedAt: new Date(),
  };
  assert.equal(isResumeHealthyForActivation(noFile), false);
  assert.match(resumeHealthLabel(noFile), /No file/);
});

test("a locally stored resume is healthy once text is extracted", () => {
  const local = {
    storagePath: "/Users/me/Library/Application Support/JobAgent/Resumes/a.pdf",
    resumeTextChars: 1200,
    extractionError: null,
    textExtractedAt: new Date(),
  };
  assert.equal(isResumeHealthyForActivation(local), true);
  assert.equal(resumeHealthLabel(local), "Healthy");
});

test("a thin or failed extraction blocks activation regardless of storage", () => {
  assert.equal(
    isResumeHealthyForActivation({
        storagePath: "/store/a.pdf",
      resumeTextChars: 200,
      extractionError: null,
      textExtractedAt: new Date(),
    }),
    false,
  );
  assert.match(
    resumeHealthLabel({
        storagePath: "/store/a.pdf",
      resumeTextChars: 200,
      extractionError: null,
      textExtractedAt: new Date(),
    }),
    /Thin extraction/,
  );
  assert.equal(
    isResumeHealthyForActivation({
        storagePath: "/store/a.pdf",
      resumeTextChars: 2000,
      extractionError: "pdf parse failed",
      textExtractedAt: new Date(),
    }),
    false,
  );
});
