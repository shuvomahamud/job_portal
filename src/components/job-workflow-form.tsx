"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { JOB_STATUSES, PRIORITIES } from "@/lib/constants";
import { humanize } from "@/lib/format";

type JobStatus = (typeof JOB_STATUSES)[number];
type JobPriority = (typeof PRIORITIES)[number];

type SaveState = {
  status: "idle" | "success" | "error";
  message: string;
};

const initialSaveState: SaveState = {
  status: "idle",
  message: "",
};

export function JobWorkflowForm({
  jobId,
  jobTitle,
  status,
  priority,
  compact = false,
  refreshAfterSave = false,
}: {
  jobId: string;
  jobTitle: string;
  status: JobStatus;
  priority: JobPriority;
  compact?: boolean;
  refreshAfterSave?: boolean;
}) {
  const router = useRouter();
  const [selectedStatus, setSelectedStatus] = useState(status);
  const [selectedPriority, setSelectedPriority] = useState(priority);
  const [state, setState] = useState<SaveState>(initialSaveState);
  const [pending, setPending] = useState(false);

  const saveWorkflow = async (
    nextStatus: JobStatus,
    nextPriority: JobPriority,
    previousStatus: JobStatus,
    previousPriority: JobPriority,
  ) => {
    setPending(true);
    setState({ status: "idle", message: "Saving workflow…" });

    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: nextStatus,
          priority: nextPriority,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        throw new Error(
          payload?.error?.message || "Workflow could not be saved.",
        );
      }

      setState({ status: "success", message: "Workflow saved." });
      if (refreshAfterSave) router.refresh();
    } catch (error) {
      setSelectedStatus(previousStatus);
      setSelectedPriority(previousPriority);
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Workflow could not be saved.",
      });
    } finally {
      setPending(false);
    }
  };

  const changeStatus = (value: string) => {
    const nextStatus = value as JobStatus;
    const previousStatus = selectedStatus;
    setSelectedStatus(nextStatus);
    void saveWorkflow(
      nextStatus,
      selectedPriority,
      previousStatus,
      selectedPriority,
    );
  };

  const changePriority = (value: string) => {
    const nextPriority = value as JobPriority;
    const previousPriority = selectedPriority;
    setSelectedPriority(nextPriority);
    void saveWorkflow(
      selectedStatus,
      nextPriority,
      selectedStatus,
      previousPriority,
    );
  };

  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void saveWorkflow(
      selectedStatus,
      selectedPriority,
      selectedStatus,
      selectedPriority,
    );
  };

  const feedback = pending ? "Saving workflow…" : state.message;

  return (
    <form
      onSubmit={submitForm}
      className={compact ? "flex items-center gap-2" : "mt-5 space-y-4"}
    >
      <label className={clsx(!compact && "field")}>
        {!compact && <span>Status</span>}
        <select
          name="status"
          value={selectedStatus}
          aria-label={compact ? `Status for ${jobTitle}` : "Status"}
          className={clsx(compact && "compact-select")}
          disabled={pending}
          onChange={(event) => changeStatus(event.currentTarget.value)}
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
          value={selectedPriority}
          aria-label={compact ? `Priority for ${jobTitle}` : "Priority"}
          className={clsx(compact && "compact-select")}
          disabled={pending}
          onChange={(event) => changePriority(event.currentTarget.value)}
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
