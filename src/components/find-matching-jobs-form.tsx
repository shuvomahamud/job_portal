"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircle, SearchCheck } from "lucide-react";

type Defaults = {
  targetTitles: string[];
  targetLocations: string[];
  profileReady: boolean;
};

function commaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function FindMatchingJobsForm({ defaults }: { defaults: Defaults }) {
  const router = useRouter();
  const [sources, setSources] = useState<Array<"indeed" | "dice">>(["indeed", "dice"]);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function toggleSource(source: "indeed" | "dice") {
    setSources((current) =>
      current.includes(source)
        ? current.length === 1
          ? current
          : current.filter((item) => item !== source)
        : [...current, source],
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const payload = {
      sources,
      queries: commaList(String(form.get("queries") ?? "")),
      locations: commaList(String(form.get("locations") ?? "")),
      maxResults: Number(form.get("maxResults") ?? 10),
    };
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "find_matching_jobs", priority: "normal", payloadJson: payload }),
      });
      const body = await response.json();
      if (!response.ok) {
        const details = body.error?.details
          ?.map((item: { path: string; message: string }) => (item.path ? `${item.path}: ${item.message}` : item.message))
          .join(" ");
        throw new Error(details ?? body.error?.message ?? "Could not start matching.");
      }
      setMessage("Finding real postings and staging them for local AI matching.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start matching.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel p-5 sm:p-7">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">AI job search</p>
          <h2 className="section-title">Find matching jobs</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Indeed and Dice postings are checked against your profile before they appear in the dashboard.
          </p>
        </div>
      </div>
      <form onSubmit={submit} className="mt-6 grid gap-5 sm:grid-cols-2">
        <fieldset className="field sm:col-span-2">
          <legend>Sources</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {(["indeed", "dice"] as const).map((source) => (
              <label className="flex items-center gap-2 text-sm text-[var(--ink)]" key={source}>
                <input
                  type="checkbox"
                  checked={sources.includes(source)}
                  onChange={() => toggleSource(source)}
                />
                {source === "indeed" ? "Indeed" : "Dice"}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>Target roles</span>
          <input
            name="queries"
            required
            defaultValue={defaults.targetTitles.join(", ")}
            placeholder="Senior .NET Engineer, Application Support"
          />
        </label>
        <label className="field">
          <span>Locations</span>
          <input
            name="locations"
            required
            defaultValue={defaults.targetLocations.join(", ")}
            placeholder="Remote, New York"
          />
        </label>
        <label className="field">
          <span>Maximum jobs</span>
          <select name="maxResults" defaultValue="10">
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </select>
        </label>
        <div className="flex items-end">
          <button className="primary-button w-full" disabled={submitting || !defaults.profileReady || sources.length === 0}>
            {submitting ? <LoaderCircle className="size-4 animate-spin" /> : <SearchCheck className="size-4" />}
            Find matching jobs
          </button>
        </div>
      </form>
      {!defaults.profileReady && (
        <p className="mt-4 rounded-xl bg-[var(--soft)] p-3 text-sm leading-6 text-[var(--muted)]">
          Complete target roles, locations, work authorization, sponsorship, and your professional summary in{" "}
          <Link className="text-link" href="/profile">Profile hub</Link> before starting a run.
        </p>
      )}
      {message && <p role="status" className="mt-4 text-sm text-[var(--muted)]">{message}</p>}
    </section>
  );
}
