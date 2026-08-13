export const RESUME_MAX_BYTES = 5 * 1024 * 1024;
export const RESUME_MIN_HEALTHY_CHARS = 800;
export const RESUME_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export type ResumeHealthInput = {
  /** Absolute path in the JobAgent local resume store. */
  storagePath: string | null;
  resumeTextChars: number | null;
  extractionError: string | null;
  textExtractedAt: Date | string | null;
};

function hasFile(resume: ResumeHealthInput): boolean {
  return Boolean(resume.storagePath);
}

export function isResumeHealthyForActivation(resume: ResumeHealthInput): boolean {
  if (!hasFile(resume)) return false;
  if (resume.extractionError) return false;
  if (!resume.textExtractedAt) return false;
  if ((resume.resumeTextChars ?? 0) < RESUME_MIN_HEALTHY_CHARS) return false;
  return true;
}

export function resumeHealthLabel(resume: ResumeHealthInput): string {
  if (!hasFile(resume)) return "No file — add it in JobAgent";
  if (resume.extractionError) return "Extraction failed";
  if (!resume.textExtractedAt) return "Text not extracted";
  if ((resume.resumeTextChars ?? 0) < RESUME_MIN_HEALTHY_CHARS) {
    return `Thin extraction (${resume.resumeTextChars ?? 0} chars)`;
  }
  return "Healthy";
}
