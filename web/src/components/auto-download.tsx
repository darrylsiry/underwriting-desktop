"use client";

import { useEffect, useRef } from "react";

/**
 * Starts a file download once the page has rendered (UX-022): the Accounting page lands here after
 * a push with the batch named, and the file follows without another click. Same-origin URLs only;
 * the server answers with Content-Disposition: attachment, so the page stays put. The banner's
 * parameters are dropped from the address so a reload doesn't download twice.
 */
export function AutoDownload({ href, strip = [] }: { href: string; strip?: string[] }) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !href.startsWith("/")) return;
    started.current = true;
    const url = new URL(window.location.href);
    for (const k of strip) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", url);
    window.location.assign(href);
  }, [href, strip]);
  return null;
}
