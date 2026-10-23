export const RATING_SERVICE_URL = process.env.RATING_SERVICE_URL ?? "http://localhost:8001";
export const INGESTION_SERVICE_URL = process.env.INGESTION_SERVICE_URL ?? "http://localhost:8002";

/**
 * Ping rating and ingestion so Fly starts their machines if they auto-stopped while idle. Called
 * when the Submissions page loads, so they're usually up before the underwriter clicks Extract.
 */
export async function wakeServices(): Promise<void> {
  await Promise.allSettled([RATING_SERVICE_URL, INGESTION_SERVICE_URL].map((url) =>
    fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000), cache: "no-store" })));
}
