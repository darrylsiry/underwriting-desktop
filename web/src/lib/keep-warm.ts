// Keep rating and ingestion awake while the web app is: on Fly every machine auto-stops when idle,
// and a cold rating or ingestion machine adds seconds to the first Extract or Save & rate.
// Pure module (the ping is passed in) so node:test can drive it with fake timers.

export const DEFAULT_INTERVAL_MS = 60_000;

/** Interval from KEEP_WARM_INTERVAL_MS; "0" turns keep-warm off. */
export function keepWarmInterval(env: Record<string, string | undefined>): number {
  const raw = env.KEEP_WARM_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_INTERVAL_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_INTERVAL_MS;
}

/**
 * Ping right away (the web machine just started, likely because someone is signing in), then every
 * `intervalMs` for as long as this process runs. When Fly stops the idle web machine the pings stop
 * too, so the services go back to sleep a few minutes later. Returns a function that stops it.
 */
export function startKeepWarm(ping: () => Promise<unknown>, intervalMs: number): () => void {
  if (!intervalMs) return () => {};
  const run = () => { ping().catch(() => {}); };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.(); // never keeps the process alive on its own
  return () => clearInterval(timer);
}
