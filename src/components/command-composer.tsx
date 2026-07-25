"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Play } from "lucide-react";
import { COMMAND_TYPES, PRIORITIES } from "@/lib/constants";
import { humanize } from "@/lib/format";

const payloadExamples: Record<(typeof COMMAND_TYPES)[number], object> = {
  run_job_search: {
    sources: ["linkedin", "indeed"],
    queries: ["senior software engineer"],
    locations: ["New York", "Remote"],
    limit: 40,
  },
  import_jobs: {
    source: "linkedin",
    urls: ["https://www.linkedin.com/jobs/view/example"],
  },
  run_rule_filter: { ruleset: "default" },
  run_local_llm_extraction: {
    jobIds: ["00000000-0000-4000-8000-000000000000"],
  },
  review_top_jobs: { limit: 10, minimumFitScore: 75 },
  review_job: {
    jobId: "00000000-0000-4000-8000-000000000000",
    reviewerType: "codex",
  },
  draft_answer: {
    jobId: "00000000-0000-4000-8000-000000000000",
    questionKey: "why_company",
  },
  trigger_n8n_summary: { period: "daily" },
  sync_n8n_email_events: {},
  mark_application_status: {
    applicationId: "00000000-0000-4000-8000-000000000000",
    status: "screening",
  },
  reprocess_job: {
    jobId: "00000000-0000-4000-8000-000000000000",
    stages: ["normalize", "extract"],
  },
};

export function CommandComposer() {
  const router = useRouter();
  const [type, setType] =
    useState<(typeof COMMAND_TYPES)[number]>("run_job_search");
  const [payload, setPayload] = useState(
    JSON.stringify(payloadExamples.run_job_search, null, 2),
  );
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function changeType(nextType: (typeof COMMAND_TYPES)[number]) {
    setType(nextType);
    setPayload(JSON.stringify(payloadExamples[nextType], null, 2));
    setMessage(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);

    try {
      const payloadJson = JSON.parse(payload);
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          priority: form.get("priority"),
          payloadJson,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        const details = body.error?.details
          ?.map((item: { path: string; message: string }) =>
            item.path ? `${item.path}: ${item.message}` : item.message,
          )
          .join(" ");
        throw new Error(details ?? body.error?.message ?? "Command failed.");
      }
      setMessage(`Queued ${humanize(type)} successfully.`);
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Command could not be queued.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel p-5 sm:p-6">
      <div className="mb-6">
        <p className="eyebrow">Manual dispatch</p>
        <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[var(--ink)]">
          Queue a command
        </h2>
      </div>
      <div className="space-y-5">
        <label className="field">
          <span>Command type</span>
          <select
            value={type}
            onChange={(event) =>
              changeType(event.target.value as (typeof COMMAND_TYPES)[number])
            }
          >
            {COMMAND_TYPES.map((commandType) => (
              <option value={commandType} key={commandType}>
                {humanize(commandType)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Priority</span>
          <select name="priority" defaultValue="normal">
            {PRIORITIES.map((priority) => (
              <option value={priority} key={priority}>
                {humanize(priority)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Structured payload</span>
          <textarea
            className="font-mono text-xs leading-6"
            rows={12}
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="mt-5 rounded-xl bg-[var(--soft)] p-3 text-xs leading-5 text-[var(--muted)]">
        Payload fields are validated for the selected type. Shell, script, and
        executable fields are always rejected.
      </div>
      <button className="primary-button mt-5 w-full" disabled={submitting}>
        {submitting ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        Queue command
      </button>
      {message && (
        <p role="status" className="mt-3 text-sm leading-5 text-[var(--muted)]">
          {message}
        </p>
      )}
    </form>
  );
}
