import { AlertTriangle, Ban, RotateCcw } from "lucide-react";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { requireDashboardUser } from "@/lib/auth";
import { compactJson, formatDateTime, humanize } from "@/lib/format";
import { listCommands } from "@/services/commands";
import { cancelQueuedCommand, retryCommand } from "../actions";

export default async function CommandsPage() {
  const user = await requireDashboardUser();
  const commandRows = await listCommands({ limit: 100, requestedBy: user.id });

  return (
    <>
      <PageHeader
        eyebrow="Auditable automation"
        title="Automation audit"
        description="Matching runs are created from the overview. This page is an advanced audit trail, not a manual command console."
      />
      <div>
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-5 sm:px-6">
            <div>
              <h2 className="section-title">Queue history</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {commandRows.length} recent command
                {commandRows.length === 1 ? "" : "s"}
              </p>
            </div>
            <span className="source-chip">Allow-list enforced</span>
          </div>

          {commandRows.length ? (
            <div className="divide-y divide-[var(--line)]">
              {commandRows.map((command) => (
                <details key={command.id} className="command-row group">
                  <summary>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold tracking-[-0.015em] text-[var(--ink)]">
                          {humanize(command.type)}
                        </p>
                        <StatusBadge value={command.status} />
                        {command.priority !== "normal" && (
                          <StatusBadge
                            value={command.priority}
                            tone={
                              command.priority === "urgent"
                                ? "danger"
                                : "warning"
                            }
                          />
                        )}
                      </div>
                      <p className="mt-2 text-xs text-[var(--muted)]">
                        {humanize(command.source)} ·{" "}
                        {formatDateTime(command.createdAt)} ·{" "}
                        <span className="font-mono">{command.id.slice(0, 8)}</span>
                      </p>
                    </div>
                    <span className="details-caret">+</span>
                  </summary>
                  <div className="grid gap-4 px-5 pb-5 sm:px-6 lg:grid-cols-2">
                    <div>
                      <p className="eyebrow">Payload</p>
                      <pre className="code-block mt-2">
                        {compactJson(command.payloadJson)}
                      </pre>
                    </div>
                    <div>
                      <p className="eyebrow">Result</p>
                      <pre className="code-block mt-2">
                        {command.errorMessage
                          ? command.errorMessage
                          : compactJson(command.resultJson ?? {
                              message: "No result reported yet.",
                            })}
                      </pre>
                      {command.claimedBy && (
                        <p className="mt-3 text-xs text-[var(--muted)]">
                          Claimed by {command.claimedBy} at{" "}
                          {formatDateTime(command.claimedAt)}
                        </p>
                      )}
                      {command.status === "failed" && (
                        <form
                          action={retryCommand.bind(null, command.id)}
                          className="mt-4"
                        >
                          <button className="secondary-button">
                            <RotateCcw className="size-4" /> Retry as new command
                          </button>
                        </form>
                      )}
                      {(command.status === "pending" || command.status === "claimed") && (
                        <form
                          action={cancelQueuedCommand.bind(null, command.id)}
                          className="mt-4"
                        >
                          <button className="secondary-button">
                            <Ban className="size-4" /> Stop command
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <EmptyState
              title="The queue is quiet"
              description="Create a manual command to verify the dispatch and audit flow."
            />
          )}
        </section>
      </div>
      <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-900/10 bg-amber-100/50 p-4 text-sm leading-6 text-amber-950">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        The VPS and Mac workers claim only fixed, allow-listed command types.
        Payload content is never evaluated as a shell command.
      </div>
    </>
  );
}
