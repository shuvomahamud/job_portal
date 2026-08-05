"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

export function JobDeleteButton({
  jobId,
  jobTitle,
}: {
  jobId: string;
  jobTitle: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const deleteJob = async () => {
    const confirmed = window.confirm(
      `Delete “${jobTitle}”? Related applications, reviews, and follow-ups will also be removed.`,
    );
    if (!confirmed) return;

    setPending(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        throw new Error(payload?.error?.message || "Job could not be deleted.");
      }

      router.refresh();
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Job could not be deleted.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      className="icon-button danger-icon-button"
      aria-label={`Delete ${jobTitle}`}
      disabled={pending}
      onClick={() => void deleteJob()}
    >
      <Trash2 className="size-4" />
    </button>
  );
}
