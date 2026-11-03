"use client";

import { useEffect } from "react";

/**
 * A page's one-time result (UX-073): shown once, then dropped from the address, so a reload tomorrow can't
 * repeat today's "Rated: $13,120" over a figure a colleague has since changed.
 */
export function Flash({ msg, error }: { msg?: string; error?: string }) {
  useEffect(() => {
    if (!msg && !error) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("msg");
    url.searchParams.delete("error");
    window.history.replaceState(window.history.state, "", url);
  }, [msg, error]);
  return (
    <>
      {msg && <p className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700" role="status">{msg}</p>}
      {error && <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{error}</p>}
    </>
  );
}
