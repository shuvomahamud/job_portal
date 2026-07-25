"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { JOB_SOURCES } from "@/lib/constants";
import { humanize } from "@/lib/format";

export function ImportJobForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const techStack = String(form.get("techStack") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const payload = {
      title: form.get("title"),
      company: form.get("company"),
      location: form.get("location") || null,
      source: form.get("source"),
      sourceUrl: form.get("sourceUrl"),
      description: form.get("description"),
      salaryText: form.get("salaryText") || null,
      employmentType: form.get("employmentType") || null,
      remoteType: form.get("remoteType") || null,
      techStack,
      status: "new",
      priority: "normal",
      visaSignal: "unknown",
    };

    try {
      const response = await fetch("/api/jobs/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        const details = body.error?.details?.[0]?.message;
        throw new Error(details ?? body.error?.message ?? "Import failed.");
      }
      router.push(`/jobs/${body.data.id}`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel overflow-hidden">
      <div className="border-b border-[var(--line)] px-5 py-5 sm:px-7">
        <p className="text-sm font-semibold text-[var(--ink)]">Role identity</p>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Preserve the source URL so later workers can enrich the record.
        </p>
      </div>
      <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-7">
        <label className="field">
          <span>Job title</span>
          <input name="title" required placeholder="Senior Product Engineer" />
        </label>
        <label className="field">
          <span>Company</span>
          <input name="company" required placeholder="Acme Labs" />
        </label>
        <label className="field sm:col-span-2">
          <span>Source URL</span>
          <input
            name="sourceUrl"
            required
            type="url"
            placeholder="https://company.com/jobs/..."
          />
        </label>
        <label className="field">
          <span>Source</span>
          <select name="source" defaultValue="linkedin">
            {JOB_SOURCES.map((source) => (
              <option key={source} value={source}>
                {humanize(source)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Location</span>
          <input name="location" placeholder="New York, NY · Hybrid" />
        </label>
        <label className="field">
          <span>Salary</span>
          <input name="salaryText" placeholder="$150k–$185k" />
        </label>
        <label className="field">
          <span>Employment type</span>
          <input name="employmentType" placeholder="Full-time" />
        </label>
        <label className="field">
          <span>Remote type</span>
          <input name="remoteType" placeholder="Hybrid" />
        </label>
        <label className="field">
          <span>Tech stack</span>
          <input name="techStack" placeholder="TypeScript, React, Postgres" />
        </label>
        <label className="field sm:col-span-2">
          <span>Job description</span>
          <textarea
            name="description"
            required
            rows={14}
            placeholder="Paste the complete job description here…"
          />
        </label>
      </div>
      <div className="flex flex-col gap-3 border-t border-[var(--line)] bg-[var(--soft)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <p className="text-xs leading-5 text-[var(--muted)]">
          Saving only creates a job record. No scraping or automated application
          is triggered.
        </p>
        <button className="primary-button shrink-0" disabled={submitting}>
          {submitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <ArrowRight className="size-4" />
          )}
          Save job
        </button>
        {message && (
          <p role="alert" className="text-sm font-medium text-red-700 sm:order-first">
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
