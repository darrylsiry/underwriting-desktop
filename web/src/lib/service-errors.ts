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
