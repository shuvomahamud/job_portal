"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, CircleDot, LoaderCircle, MonitorUp, Play, Square, TriangleAlert } from "lucide-react";
import {
  markBlockerHandled,
  openBrowserToUnblock,
  startApplyCycle,
  stopApplyCycle,
} from "@/app/(dashboard)/actions";
import { MAX_APPLICATIONS_PER_RUN } from "@/lib/runLimits";

type Status = {
  running: boolean;
  searchRunning: boolean;
  phase: "queued" | "searching" | "scoring" | "waiting" | "applying" | "failed" | "idle";
  detail: string;
  startedAt: string | null;
  nextApplyAt: string | null;
  lastFailure: {
    step: string;
    message: string;
    failedAt: string | null;
  } | null;
  blockers: Array<{
    id: string;
    kind: string;
    site: string;
    message: string;
    pageUrl: string | null;
    createdAt: string;
  }>;
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
  failed: "Last run failed",
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

type Source = "indeed" | "dice";

export function ApplyCycleControl({
  initial,
  initialMaxJobs,
}: {
  initial: Status;
  initialMaxJobs: number;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [sources, setSources] = useState<Source[]>(["indeed", "dice"]);
  const [maxJobs, setMaxJobs] = useState(initialMaxJobs);

  function toggleSource(source: Source) {
    setSources((current) =>
      current.includes(source)
        ? // Never let both be unchecked; there would be nothing to search.
          current.length === 1
          ? current
          : current.filter((item) => item !== source)
        : [...current, source],
    );
  }

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
      const result = await startApplyCycle({ sources, maxJobs });
      setMessage(result.message);
      await load();
      router.refresh();
    });
  }

  function stop() {
    startTransition(async () => {
      const result = await stopApplyCycle();
      setMessage(result.message);
      await load();
      router.refresh();
    });
  }

  function handled(alertId: string) {
    startTransition(async () => {
      const result = await markBlockerHandled(alertId);
      setMessage(result.message);
      await load();
      router.refresh();
    });
  }

  function unblock(alertId: string) {
    startTransition(async () => {
      const result = await openBrowserToUnblock(alertId);
      setMessage(result.message);
      await load();
      router.refresh();
    });
  }

  const busy = pending || status.searchRunning;

  return (
    <section className="panel mb-6 p-5 sm:p-7">
      {status.blockers.length > 0 && (
        <div className="mb-5 space-y-3">
          {status.blockers.map((blocker) => (
            <div
              key={blocker.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4"
            >
              <div className="flex items-start gap-3">
                <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-700" />
                <div>
                  <p className="font-semibold text-amber-950">
                    {blocker.site} needs your attention
                  </p>
                  <p className="mt-1 text-sm text-amber-800">{blocker.message}</p>
                  {(blocker.kind === "captcha" || blocker.kind === "login_required") && (
                    <p className="mt-1 text-sm text-amber-800">
                      The apply is paused on that page. Solve it in JobAgent Chrome, then click
                      Resume automated apply.
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {blocker.kind !== "captcha" && blocker.kind !== "login_required" && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => unblock(blocker.id)}
                  disabled={pending}
                >
                  {pending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <MonitorUp className="size-4" />
                  )}
                  Open browser to unblock
                </button>
                )}
                {/*
                  The way out when the worker is wrong or the page is gone. Verification
                  cannot clear an alert raised in error, and applying stands down while any
                  alert is open — so without this a phantom blocker halts everything.
                */}
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-xl border border-amber-400 px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  onClick={() => handled(blocker.id)}
                  disabled={pending}
                  title="Clear this without the worker checking. Use when it is already sorted, or was never really blocked."
                >
                  <Check className="size-4" />
                  I&rsquo;ve handled it
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            {status.running ? (
              <LoaderCircle className="size-4 animate-spin text-[var(--accent-dark)]" />
            ) : status.phase === "failed" ? (
              <TriangleAlert className="size-4 text-amber-600" />
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
          <p
            className={`mt-2 max-w-xl text-sm leading-6 ${
              status.phase === "failed" ? "text-amber-700" : "text-[var(--muted)]"
            }`}
          >
            {status.detail}
            {status.nextApplyAt && ` Applying starts around ${clockTime(status.nextApplyAt)}.`}
          </p>
          {status.phase === "failed" && (
            <p className="mt-1 text-xs text-[var(--muted)]">
              Nothing was added to the board. Fix the cause, then run the cycle again.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <fieldset disabled={busy} className="flex flex-wrap items-end gap-4">
            <div>
              <p className="mb-1 text-xs font-semibold text-[var(--muted)]">Search</p>
              <div className="flex items-center gap-3">
                {(["indeed", "dice"] as const).map((source) => (
                  <label key={source} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={sources.includes(source)}
                      onChange={() => toggleSource(source)}
                    />
                    <span className="capitalize">{source}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="field w-28">
              <span>Apply up to</span>
              <input
                type="number"
                min={1}
                max={MAX_APPLICATIONS_PER_RUN}
                value={maxJobs}
                onChange={(event) =>
                  setMaxJobs(
                    Math.min(
                      MAX_APPLICATIONS_PER_RUN,
                      Math.max(1, Number(event.target.value) || 1),
                    ),
                  )
                }
              />
            </label>
          </fieldset>

          {status.searchRunning ? (
            // Swapped on the search alone. Scoring and applying run continuously now, so
            // keying this off "anything running" would hide Run permanently — and Stop
            // only stops searching anyway.
            <button
              className="primary-button"
              type="button"
              onClick={stop}
              disabled={pending}
            >
              {pending ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" /> Stopping
                </>
              ) : (
                <>
                  <Square className="size-4" /> Stop job search
                </>
              )}
            </button>
          ) : (
            <button className="primary-button" type="button" onClick={start} disabled={pending}>
              {pending ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" /> Starting
                </>
              ) : (
                <>
                  <Play className="size-4" /> Search jobs
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {!status.running && sources.length > 1 && (
        <p className="mt-3 text-xs text-[var(--muted)]">
          Split evenly: about {Math.ceil(maxJobs / 2)} from Indeed and{" "}
          {Math.floor(maxJobs / 2)} from Dice. If one board runs short, the other takes
          the remainder.
        </p>
      )}

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
