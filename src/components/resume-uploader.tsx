"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { upload } from "@vercel/blob/client";
import { LoaderCircle, Upload } from "lucide-react";
import { RESUME_ALLOWED_MIME_TYPES, RESUME_MAX_BYTES } from "@/lib/resumeHealth";

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function ResumeUploader({ userId }: { userId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) {
      setMessage("Choose a PDF or DOCX file.");
      return;
    }
    if (file.size > RESUME_MAX_BYTES) {
      setMessage("Resume must be 5 MB or smaller.");
      return;
    }
    if (!RESUME_ALLOWED_MIME_TYPES.includes(file.type as (typeof RESUME_ALLOWED_MIME_TYPES)[number])) {
      setMessage("Only PDF and DOCX resumes are allowed.");
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const sha256 = await sha256Hex(file);
      const label = name.trim() || file.name.replace(/\.[^.]+$/, "");
      const pathname = `resumes/${userId}/${file.name}`;
      const blob = await upload(pathname, file, {
        access: "private",
        handleUploadUrl: "/api/resumes/upload-token",
        clientPayload: JSON.stringify({
          name: label,
          sha256,
          originalFilename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      });

      const complete = await fetch("/api/resumes/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: label,
          blobPathname: blob.pathname,
          originalFilename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          sha256,
        }),
      });
      const body = await complete.json();
      if (!complete.ok) {
        throw new Error(body.error?.message ?? "Could not save resume metadata.");
      }

      setName("");
      fileInput.value = "";
      setMessage("Resume uploaded. Queue a text extraction from Roles when ready.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-4">
      <label className="field">
        <span>Label</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Senior .NET · 2026"
          maxLength={200}
        />
      </label>
      <label className="field">
        <span>PDF or DOCX (max 5 MB)</span>
        <input name="file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required />
      </label>
      <button className="secondary-button w-full" disabled={busy}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
        Upload private resume
      </button>
      {message && (
        <p role="status" className="text-sm text-[var(--muted)]">
          {message}
        </p>
      )}
    </form>
  );
}
