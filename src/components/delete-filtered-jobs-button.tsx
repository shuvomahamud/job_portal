"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { humanize } from "@/lib/format";

type FilterQuery = {
  status?: string;
  source?: string;
  company?: string;
  minScore?: number;
  search?: string;
  visibility?: "dashboard" | "all";
};

function describeFilters(query: FilterQuery) {
  const parts: string[] = [];
  if (query.status) parts.push(`status ${humanize(query.status)}`);
  if (query.source) parts.push(`source ${humanize(query.source)}`);
  if (query.company) parts.push(`company “${query.company}”`);
  if (query.search) parts.push(`search “${query.search}”`);
  if (query.minScore !== undefined) parts.push(`min score ${query.minScore}`);
  if (!parts.length) return "the current view";
  return parts.join(", ");
}

export function DeleteFilteredJobsButton({
  query,
  matchCount,
}: {
  query: FilterQuery;
  matchCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const filterLabel = describeFilters(query);
  const statusLabel = query.status ? humanize(query.status) : null;

  const deleteFiltered = async () => {
    if (matchCount === 0) return;

    const confirmed = window.confirm(
      statusLabel
        ? `Delete all ${statusLabel} jobs matching these filters?\n\nThis permanently removes every matching job (not only the rows on this page), plus related applications, reviews, and follow-ups.`
        : `Delete all jobs matching ${filterLabel}?\n\nThis permanently removes every matching job (not only the rows on this page), plus related applications, reviews, and follow-ups.`,
    );
    if (!confirmed) return;

    setPending(true);
    try {
      const params = new URLSearchParams();
      if (query.visibility) params.set("visibility", query.visibility);
      if (query.status) params.set("status", query.status);
      if (query.source) params.set("source", query.source);
      if (query.company) params.set("company", query.company);
      if (query.search) params.set("search", query.search);
      if (query.minScore !== undefined) {
        params.set("minScore", String(query.minScore));
      }

      const response = await fetch(`/api/jobs?${params.toString()}`, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: { deletedCount?: number };
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        throw new Error(
          payload?.error?.message || "Filtered jobs could not be deleted.",
        );
      }

      router.refresh();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Filtered jobs could not be deleted.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      className="danger-button"
      disabled={pending || matchCount === 0}
      onClick={() => void deleteFiltered()}
    >
      <Trash2 className="size-4" />
      {pending
        ? "Deleting…"
        : statusLabel
          ? `Delete all ${statusLabel}`
          : "Delete filtered"}
    </button>
  );
}
