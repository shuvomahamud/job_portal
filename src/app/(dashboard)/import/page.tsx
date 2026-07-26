import { ImportJobForm } from "@/components/import-job-form";
import { PageHeader } from "@/components/ui";

export default function ImportPage() {
  return (
    <>
      <PageHeader
        eyebrow="Manual intake"
        title="Import a job"
        description="Capture a complete source record now. Enrichment and automated imports arrive in later phases."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_340px]">
        <ImportJobForm />
        <aside className="space-y-4">
          <div className="panel p-5">
            <p className="eyebrow">Manual intake boundary</p>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-[var(--muted)]">
              <li>• No page scraping or browser cookies.</li>
              <li>• No automatic application submission.</li>
              <li>• No model processing on save.</li>
              <li>• The canonical source URL is retained for later workers.</li>
            </ul>
          </div>
          <div className="panel-dark p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/55">
              Good intake
            </p>
            <p className="mt-3 text-sm leading-6 text-white/80">
              Paste the full description, including qualifications and benefits.
              Better source data makes filtering and review more reliable later.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
