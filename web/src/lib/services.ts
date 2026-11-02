export const RATING_SERVICE_URL = process.env.RATING_SERVICE_URL ?? "http://localhost:8001";
export const INGESTION_SERVICE_URL = process.env.INGESTION_SERVICE_URL ?? "http://localhost:8002";

/**
 * The shared secret the rating service wants before it trusts who we say is acting (SEC-002):
 * `RATING_ADMIN_TOKEN`, the same value on both apps (a Fly secret; scripts/fly-deploy.sh sets it).
 * Unset locally, where the service runs open on localhost and trusts the header as before.
 */
export function ratingAuthHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const token = env.RATING_ADMIN_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Who is acting, for the rating service. Percent-encoded because a header value must be Latin-1 and
 * a "Working as" name can be anything (fetch throws on `Łukasz` otherwise); the service decodes it (CR-072).
 */
export const actingUserHeaders = (name: string): Record<string, string> => ({ "x-uw-user": encodeURIComponent(name) });

/**
 * Ping rating and ingestion so Fly starts their machines if they auto-stopped while idle. Run by
 * keep-warm (src/instrumentation.ts): when the web process starts and every minute while it runs.
 */
export async function wakeServices(): Promise<boolean> {
  const results = await Promise.allSettled([RATING_SERVICE_URL, INGESTION_SERVICE_URL].map((url) =>
    fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000), cache: "no-store" })));
  // True only when both answered OK; keep-warm retries sooner otherwise (e.g. Fly refused a start).
  return results.every((r) => r.status === "fulfilled" && r.value.ok);
}
