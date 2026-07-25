import {
  CheckCircle2,
  CircleDashed,
  KeyRound,
  Network,
  ShieldCheck,
} from "lucide-react";
import { PageHeader, SectionHeading } from "@/components/ui";
import { INTEGRATIONS } from "@/lib/constants";

const endpoints = [
  ["Hermes", "POST /api/commands", "HERMES_COMMAND_SECRET"],
  [
    "VPS worker",
    "POST /api/worker/claim-command",
    "WORKER_API_SECRET",
  ],
  [
    "VPS worker",
    "POST /api/worker/complete-command",
    "WORKER_API_SECRET",
  ],
  ["VPS worker", "POST /api/worker/fail-command", "WORKER_API_SECRET"],
  ["n8n", "POST /api/n8n/events", "N8N_WEBHOOK_SECRET"],
  ["Extension", "GET /api/extension/profile", "EXTENSION_API_SECRET"],
  ["Extension", "GET /api/extension/job/:id", "EXTENSION_API_SECRET"],
] as const;

export default function SettingsPage() {
  const baseUrl = process.env.APP_BASE_URL ?? "Not configured";

  return (
    <>
      <PageHeader
        eyebrow="Integration map"
        title="Settings & API"
        description="Configuration status is visible; secret values never leave the server."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,.65fr)]">
        <section className="panel p-5 sm:p-7">
          <SectionHeading
            title="Connected components"
            description="Each external source receives one secret with the smallest useful scope."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {INTEGRATIONS.map((integration) => {
              const configured = Boolean(process.env[integration.variable]);
              return (
                <article
                  className="rounded-2xl border border-[var(--line)] bg-white/55 p-5"
                  key={integration.name}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-[var(--ink)]">
                      {integration.name}
                    </p>
                    <span
                      className={
                        configured
                          ? "config-state config-ready"
                          : "config-state"
                      }
                    >
                      {configured ? (
                        <CheckCircle2 className="size-3.5" />
                      ) : (
                        <CircleDashed className="size-3.5" />
                      )}
                      {configured ? "Configured" : "Missing"}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                    {integration.purpose}
                  </p>
                  <p className="mt-4 font-mono text-[11px] text-[var(--muted)]">
                    {integration.variable}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="space-y-6">
          <section className="panel-dark p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <KeyRound className="size-5 text-[var(--accent)]" />
              <p className="font-semibold text-white">Secret hygiene</p>
            </div>
            <p className="mt-4 text-sm leading-6 text-white/70">
              Use independent values of at least 32 random bytes. Send them as a
              Bearer token or the integration-specific header documented in the
              README. Rotate one scope without disrupting the others.
            </p>
          </section>
          <section className="panel p-5 sm:p-6">
            <p className="eyebrow">Application origin</p>
            <p className="mt-3 break-all text-sm font-medium text-[var(--ink)]">
              {baseUrl}
            </p>
            <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
              APP_BASE_URL is used for absolute links and deployment metadata.
            </p>
          </section>
          <section className="panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <ShieldCheck className="size-5 text-[var(--accent-dark)]" />
              <p className="font-semibold text-[var(--ink)]">Never stored</p>
            </div>
            <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
              LinkedIn, Indeed, or Dice credentials; browser cookies; Codex auth;
              VPS SSH keys; and raw shell commands are outside the data model.
            </p>
          </section>
        </aside>
      </div>

      <section className="panel mt-6 overflow-hidden">
        <div className="border-b border-[var(--line)] px-5 py-5 sm:px-7">
          <div className="flex items-center gap-3">
            <Network className="size-5 text-[var(--accent-dark)]" />
            <div>
              <h2 className="section-title">Service endpoints</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Dashboard API routes use the signed-in Clerk session.
              </p>
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Endpoint</th>
                <th>Required scope</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map(([component, endpoint, secret]) => (
                <tr key={`${component}-${endpoint}`}>
                  <td className="font-medium text-[var(--ink)]">{component}</td>
                  <td>
                    <code className="font-mono text-xs text-[var(--accent-dark)]">
                      {endpoint}
                    </code>
                  </td>
                  <td>
                    <code className="font-mono text-xs text-[var(--muted)]">
                      {secret}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
