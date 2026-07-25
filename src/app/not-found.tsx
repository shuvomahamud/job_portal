import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Logo } from "@/components/logo";

export default function NotFound() {
  return (
    <main className="grid min-h-[70vh] place-items-center px-4 py-16">
      <div className="max-w-md text-center">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <p className="eyebrow">404 · Off the map</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-[var(--ink)]">
          This record isn’t here.
        </h1>
        <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
          It may have moved, been removed, or never existed.
        </p>
        <Link href="/" className="primary-button mt-7">
          <ArrowLeft className="size-4" /> Return to overview
        </Link>
      </div>
    </main>
  );
}
