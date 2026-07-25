"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="grid min-h-screen place-items-center bg-[#f5f3ec] px-4">
          <div className="max-w-md text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#68756f]">
              Searchlight
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-[#17352d]">
              The request lost its signal.
            </h1>
            <p className="mt-4 text-sm leading-6 text-[#68756f]">
              No data was intentionally changed. Try the request once more.
            </p>
            <button
              onClick={reset}
              className="mt-7 min-h-11 rounded-xl bg-[#17352d] px-5 text-sm font-semibold text-white"
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
