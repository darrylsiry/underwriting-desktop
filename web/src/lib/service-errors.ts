// Plain-language wording for a backing service that failed (UX-008). Pure module for node:test.

/** A service answered with an error status. `detail` is the service's own message, when it gave one. */
export class ServiceError extends Error {
  readonly status: number;
  readonly detail: string | null;
  constructor(status: number, detail: string | null = null) {
    super(detail ?? `Request failed (${status})`);
    this.name = "ServiceError";
    this.status = status;
    this.detail = detail;
  }
}

/** The error text of a service reply body: FastAPI's `detail`, this app's `{ error: { message } }`, or a trimmed snippet of whatever came back. */
export function errorDetailOf(body: string): string | null {
  try {
    const j = JSON.parse(body);
    const d = j?.detail ?? j?.error?.message ?? j?.error;
    if (typeof d === "string" && d.trim()) return d.trim();
    if (d && typeof d === "object") return JSON.stringify(d);
  } catch { /* not JSON */ }
  const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 160) : null;
}

/**
 * What to tell the user when `service` ("document reader", "rating service") failed. Nothing is
 * saved by a failed call, and the sentence says so and what to do next:
 * - no answer at all (network error, timeout, abort) → "isn't responding … try again in a moment"
 * - 5xx → "hit a problem (502) … try again"
 * - 4xx with the service's own detail → that detail alone (it already says what was wrong)
 */
export function describeServiceError(err: unknown, service = "document reader"): string {
  const name = `The ${service}`;
  if (err instanceof ServiceError || (err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number")) {
    const { status, detail } = err as { status: number; detail?: string | null };
    if (status >= 500) return `${name} hit a problem (${status}). Nothing was saved; try again.`;
    if (detail) return detail;
    return `${name} refused the request (${status}). Nothing was saved.`;
  }
  const e = err as { name?: string; message?: string } | null;
  const message = e?.message ?? "";
  const noAnswer = e?.name === "TypeError" || e?.name === "AbortError" || e?.name === "TimeoutError"
    || /fetch failed|network|timed? ?out|ECONNREFUSED|ECONNRESET|ENOTFOUND|aborted/i.test(message);
  if (noAnswer || !message) return `${name} isn't responding. Nothing was saved; try again in a moment.`;
  return `${name} hit a problem (${message}). Nothing was saved; try again.`;
}

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The page for a proxied admin request the service never answered (CR-108): 504 when it timed out,
 * 502 when it couldn't be reached, in plain words, with a way to try again. A form post that timed
 * out may still have gone through, so it says that rather than "nothing was saved", and its retry
 * goes back to the admin's front page because the post's own address can't be opened on its own.
 */
export function proxyFailurePage(err: unknown, service: string, method: string, path: string): { status: 502 | 504; html: string } {
  const name = (err as { name?: string } | null)?.name;
  const timedOut = name === "TimeoutError" || name === "AbortError";
  const posted = method !== "GET" && method !== "HEAD";
  const message = timedOut && posted
    ? `The ${service} didn't answer in time, so your change may or may not have been saved. Check it before saving again.`
    : describeServiceError(err, service);
  return {
    status: timedOut ? 504 : 502,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rate tables unavailable · Underwriting Desktop</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border:1px solid #e2e8f0;border-radius:.5rem;padding:2rem;width:min(26rem,90vw)}h1{font-size:1.125rem;margin:0 0 .5rem}p{color:#475569;font-size:.875rem;margin:0 0 1.25rem}
a{color:#4f46e5;font-size:.875rem}a.retry{background:#4f46e5;color:#fff;border-radius:.375rem;padding:.5rem 1rem;text-decoration:none;margin-right:1rem;display:inline-block}</style></head>
<body><main><h1>Rate tables aren't available right now</h1><p>${html(message)}</p>
<a class="retry" href="${html(posted ? "/admin" : path)}">Try again</a><a href="/">Back to the desk</a></main></body></html>`,
  };
}
