"use client";

import Link from "next/link";

/**
 * What a page shows when something it depends on fails (a database away, a service mid-restart,
 * a bad id), styled like the rest of the app instead of Next's default (CR-027). In production the
 * message is Next's generic one; the digest matches the server log line.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-6xl p-8">
      <section className="mx-auto max-w-lg rounded-lg border border-rose-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Something went wrong on this page</h1>
        <p className="mt-2 text-sm text-slate-600">
          The page couldn&apos;t be built. That is usually a database or a service that isn&apos;t answering; the
          data you saved is still saved.
        </p>
        <p className="mt-3 rounded bg-rose-50 px-3 py-2 font-mono text-xs text-rose-800">
          {error.message}{error.digest ? ` (ref ${error.digest})` : ""}
        </p>
        <div className="mt-5 flex gap-3 text-sm">
          <button onClick={reset} className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">Try again</button>
          <Link href="/" className="rounded-md border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-50">Back to my desk</Link>
          <Link href="/api/health" className="self-center text-indigo-600 hover:underline">System status</Link>
        </div>
      </section>
    </main>
  );
}
