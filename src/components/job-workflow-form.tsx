"use client";

import { useActionState, useRef } from "react";
import { clsx } from "clsx";
import type { JobWorkflowActionState } from "@/app/(dashboard)/actions";
import { updateJobWorkflow } from "@/app/(dashboard)/actions";
import { JOB_STATUSES, PRIORITIES } from "@/lib/constants";
import { humanize } from "@/lib/format";

type JobStatus = (typeof JOB_STATUSES)[number];
type JobPriority = (typeof PRIORITIES)[number];

const initialActionState: JobWorkflowActionState = {
  status: "idle",
  message: "",
};

export function JobWorkflowForm({
  jobId,
  jobTitle,
  status,
  priority,
  compact = false,
}: {
  jobId: string;
  jobTitle: string;
  status: JobStatus;
  priority: JobPriority;
  compact?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(
    updateJobWorkflow,
    initialActionState,
  );

  const saveOnChange = () => {
    formRef.current?.requestSubmit();
  };

  const feedback = pending ? "Saving workflow…" : state.message;

  return (
    <form
      action={formAction}
      ref={formRef}
      className={compact ? "flex items-center gap-2" : "mt-5 space-y-4"}
    >
      <input type="hidden" name="jobId" value={jobId} />
      <label className={clsx(!compact && "field")}>
        {!compact && <span>Status</span>}
        <select
          name="status"
          defaultValue={status}
          aria-label={compact ? `Status for ${jobTitle}` : "Status"}
          className={clsx(compact && "compact-select")}
          disabled={pending}
          onChange={saveOnChange}
        >
          {JOB_STATUSES.map((jobStatus) => (
            <option key={jobStatus} value={jobStatus}>
              {humanize(jobStatus)}
            </option>
          ))}
        </select>
      </label>
      <label className={clsx(!compact && "field")}>
        {!compact && <span>Priority</span>}
        <select
          name="priority"
          defaultValue={priority}
          aria-label={compact ? `Priority for ${jobTitle}` : "Priority"}
          className={clsx(compact && "compact-select")}
          disabled={pending}
          onChange={saveOnChange}
        >
          {PRIORITIES.map((jobPriority) => (
            <option key={jobPriority} value={jobPriority}>
              {humanize(jobPriority)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={pending}
        className={compact ? "mini-button" : "primary-button w-full"}
      >
        {pending ? "Saving…" : state.status === "success" ? "Saved" : "Save"}
      </button>
      {compact ? (
        <span className="sr-only" role="status" aria-live="polite">
          {feedback}
        </span>
      ) : (
        <p
          role="status"
          aria-live="polite"
          className={clsx(
            "min-h-5 text-sm",
            state.status === "error"
              ? "text-[var(--red)]"
              : "text-[var(--muted)]",
          )}
        >
          {feedback}
        </p>
      )}
    </form>
  );
}
