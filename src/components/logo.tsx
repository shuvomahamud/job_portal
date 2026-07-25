import { ArrowUpRight } from "lucide-react";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-[14px] bg-[var(--ink)] text-[var(--paper)] shadow-[0_8px_24px_rgba(24,37,31,.16)]">
        <ArrowUpRight className="size-5" strokeWidth={2.25} />
      </span>
      {!compact && (
        <span>
          <span className="block text-[15px] font-semibold tracking-[-0.02em] text-[var(--ink)]">
            Searchlight
          </span>
          <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
            Command center
          </span>
        </span>
      )}
    </div>
  );
}
