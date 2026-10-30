export const RATING_SERVICE_URL = process.env.RATING_SERVICE_URL ?? "http://localhost:8001";
export const INGESTION_SERVICE_URL = process.env.INGESTION_SERVICE_URL ?? "http://localhost:8002";

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
