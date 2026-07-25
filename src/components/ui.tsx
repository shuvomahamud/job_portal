import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { clsx } from "clsx";
import { humanize } from "@/lib/format";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {action}
    </header>
  );
}

export function StatusBadge({
  value,
  tone,
}: {
  value: string;
  tone?: "neutral" | "positive" | "warning" | "danger";
}) {
  const inferredTone =
    tone ??
    (["completed", "ready_to_apply", "offer", "applied"].includes(value)
      ? "positive"
      : ["failed", "rejected"].includes(value)
        ? "danger"
        : ["pending", "needs_review", "urgent"].includes(value)
          ? "warning"
          : "neutral");

  return (
    <span className={clsx("status-badge", `status-${inferredTone}`)}>
      <span aria-hidden="true" className="status-dot" />
      {humanize(value)}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  icon: Icon,
  detail,
  accent = false,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  detail: string;
  accent?: boolean;
}) {
  return (
    <article className={clsx("metric-card", accent && "metric-card-accent")}>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm font-medium text-[var(--muted)]">{label}</p>
        <span className="metric-icon">
          <Icon className="size-4" />
        </span>
      </div>
      <p className="mt-7 text-[2.65rem] font-semibold leading-none tracking-[-0.055em] text-[var(--ink)]">
        {value}
      </p>
      <p className="mt-3 text-xs leading-5 text-[var(--muted)]">{detail}</p>
    </article>
  );
}

export function EmptyState({
  title,
  description,
  href,
  action,
}: {
  title: string;
  description: string;
  href?: string;
  action?: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-mark">↗</div>
      <p className="mt-4 font-semibold text-[var(--ink)]">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[var(--muted)]">
        {description}
      </p>
      {href && action && (
        <Link href={href} className="text-link mt-4 inline-flex">
          {action} <ArrowRight className="size-4" />
        </Link>
      )}
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h2 className="section-title">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
