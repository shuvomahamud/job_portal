"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleDot, LoaderCircle, Play } from "lucide-react";
import { startApplyCycle } from "@/app/(dashboard)/actions";

type Status = {
  running: boolean;
  phase: "queued" | "searching" | "scoring" | "waiting" | "applying" | "idle";
  detail: string;
  startedAt: string | null;
  nextApplyAt: string | null;
  counts: {
    applied: number;
    awaitingAnswer: number;
    needsManual: number;
    blocked: number;
    failed: number;
  };
  recent: Array<{
    jobId: string;
    title: string;
    company: string;
    status: string;
    stopReason: string | null;
    updatedAt: string;
  }>;
};

const PHASE_LABEL: Record<Status["phase"], string> = {
  queued: "Queued",
  searching: "Searching job boards",
  scoring: "Scoring matches",
  waiting: "Waiting to apply",
  applying: "Applying",
  idle: "Idle",
};

/** Poll interval. Slow on purpose: the run itself is paced in minutes, not seconds. */
const POLL_MS = 30_000;

function clockTime(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function elapsed(from: string | null) {
  if (!from) return null;
  const minutes = Math.floor((Date.now() - new Date(from).getTime()) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function ApplyCycleControl({ initial }: { initial: Status }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/apply-cycle/status", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json();
      if (body?.data) setStatus(body.data as Status);
    } catch {
      // A failed poll is not worth surfacing; the next one is 30s away.
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(load, POLL_MS);
    // Catch up immediately when the tab is brought back into focus.
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  function start() {
    startTransition(async () => {
      const result = await startApplyCycle();
      setMessage(result.message);
      await load();
      router.refresh();
    });
  }

  const busy = pending || status.running;

  return (
    <section className="panel mb-6 p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            {status.running ? (
              <LoaderCircle className="size-4 animate-spin text-[var(--accent-dark)]" />
            ) : (
              <CircleDot className="size-4 text-[var(--muted)]" />
            )}
            <p className="font-semibold text-[var(--ink)]">
              {PHASE_LABEL[status.phase]}
            </p>
            {status.running && elapsed(status.startedAt) && (
              <span className="source-chip">{elapsed(status.startedAt)}</span>
            )}
          </div>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--muted)]">
            {status.detail}
            {status.nextApplyAt && ` Applying starts around ${clockTime(status.nextApplyAt)}.`}
          </p>
        </div>

        <button
          className="primary-button"
          type="button"
          onClick={start}
          disabled={busy}
          title={status.running ? "A cycle is already running" : undefined}
        >
          {busy ? (
            <>
              <LoaderCircle className="size-4 animate-spin" /> Running
            </>
          ) : (
            <>
              <Play className="size-4" /> Run apply cycle
            </>
          )}
        </button>
      </div>

      {message && (
        <p className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--soft)] p-3 text-sm text-[var(--muted)]">
          {message}
        </p>
      )}

      <div className="mt-5 grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {(
          [
            ["Applied", status.counts.applied],
            ["Need answers", status.counts.awaitingAnswer],
            ["Needs manual", status.counts.needsManual],
            ["Blocked", status.counts.blocked],
            ["Unconfirmed", status.counts.failed],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-[var(--line)] bg-white/55 p-3">
            <p className="text-xs text-[var(--muted)]">{label}</p>
            <p className="mt-1 text-xl font-semibold text-[var(--ink)]">{value}</p>
          </div>
        ))}
      </div>

      {status.recent.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Latest activity
          </p>
          <div className="space-y-2">
            {status.recent.slice(0, 5).map((row) => (
              <div
                key={row.jobId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-white/55 px-3 py-2"
              >
                <span className="text-sm text-[var(--ink)]">
                  {row.title} <span className="text-[var(--muted)]">· {row.company}</span>
                </span>
                <span className="source-chip">{row.status.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-[var(--muted)]">
        Updates every 30 seconds. Applications are deliberately paced at human speed, with
        gaps of 1.5–7 minutes between submissions, so a full run takes a while.
      </p>
    </section>
  );
}
