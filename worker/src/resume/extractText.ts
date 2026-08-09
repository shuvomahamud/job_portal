import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const MAX_CHARS = 40_000;

function normalizeResumeText(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

export async function extractResumeText(
  absolutePath: string,
): Promise<{ text: string; chars: number; kind: "pdf" | "docx" }> {
  const extension = extname(absolutePath).toLowerCase();
  if (extension === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const data = await readFile(absolutePath);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText();
      const text = normalizeResumeText(result.text ?? "");
      return { text, chars: text.length, kind: "pdf" };
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  if (extension === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: absolutePath });
    const text = normalizeResumeText(result.value ?? "");
    return { text, chars: text.length, kind: "docx" };
  }

  throw new Error(`Unsupported resume file type: ${extension || "(none)"}`);
}
