"use client";

import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { StatusBadge } from "./ui";

type Command = {
  id: string;
  status: "pending" | "claimed" | "completed" | "failed" | "canceled";
  resultJson: Record<string, unknown> | null;
  errorMessage: string | null;
};

type RunPayload = { root: Command; children: Command[] };

function number(result: Record<string, unknown> | null | undefined, key: string) {
  const value = result?.[key];
  return typeof value === "number" ? value : 0;
}

function jobCount(result: Record<string, unknown> | null | undefined, key: string) {
  const value = result?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function runLabel(run: RunPayload) {
  const child = run.children[0];
  if (run.root.status === "failed" || child?.status === "failed") return "failed";
  if (run.root.status === "canceled" || child?.status === "canceled") return "canceled";
  if (child?.status === "claimed") return "matching";
  if (run.root.status === "claimed") return "discovering";
  if (child?.status === "pending") return "matching queued";
  if (run.root.status === "pending") return "queued";
  if (child?.status === "completed") {
    return jobCount(child.resultJson, "warnings") ? "completed with warnings" : "completed";
  }
  return run.root.status;
}

function isTerminal(run: RunPayload) {
  const status = run.children[0]?.status ?? run.root.status;
  return ["completed", "failed", "canceled"].includes(status);
}

export function MatchingRunStatus({ rootCommandId }: { rootCommandId: string }) {
  const [run, setRun] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const response = await fetch(`/api/matching-runs/${rootCommandId}`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? "Could not load matching progress.");
        const nextRun = body.data?.root ? (body.data as RunPayload) : null;
        if (!active) return;
        setRun(nextRun);
        setError(null);
        if (nextRun && !isTerminal(nextRun)) {
          timer = setTimeout(() => void load(), 4_000);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load matching progress.");
      }
    }
    void load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [rootCommandId]);

  if (error) return <p className="mt-4 text-sm text-[var(--muted)]">{error}</p>;
  if (!run) {
    return <div className="mt-5 flex items-center gap-2 text-sm text-[var(--muted)]"><LoaderCircle className="size-4 animate-spin" /> Loading run progress…</div>;
  }
  const child = run.children[0];
  const rootResult = run.root.resultJson;
  const childResult = child?.resultJson;
  const terminal = ["completed", "failed", "canceled"].includes(child?.status ?? run.root.status);
  return (
    <section className="panel mt-6 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Latest matching run</p>
          <p className="mt-1 text-lg font-semibold text-[var(--ink)]">{runLabel(run)}</p>
        </div>
        <StatusBadge value={terminal ? (child?.status ?? run.root.status) : "pending"} />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <RunMetric label="Found" value={number(rootResult, "discoveredCount")} />
        <RunMetric label="Already known" value={number(rootResult, "duplicateCount")} />
        <RunMetric label="Hard-filtered" value={number(rootResult, "hardFilteredCount")} />
        <RunMetric label="Locally checked" value={number(childResult, "evaluatedCount")} />
        <RunMetric label="Remote reviews" value={number(childResult, "remoteReviewCount")} />
        <RunMetric label="Matched" value={jobCount(childResult, "matchedJobIds")} />
        <RunMetric label="Needs review" value={jobCount(childResult, "needsReviewJobIds")} />
        <RunMetric label="Discarded" value={jobCount(childResult, "archivedJobIds")} />
        <RunMetric label="Errors" value={jobCount(childResult, "failedJobIds")} />
      </div>
      {(run.root.errorMessage || child?.errorMessage) && (
        <p className="mt-4 text-sm leading-6 text-[var(--muted)]">{child?.errorMessage ?? run.root.errorMessage}</p>
      )}
    </section>
  );
}

function RunMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-[var(--soft)] p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-[-0.04em] text-[var(--ink)]">{value}</p>
    </div>
  );
}
