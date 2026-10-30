// Keep rating and ingestion awake while the web app is: on Fly every machine auto-stops when idle,
// and a cold rating or ingestion machine adds seconds to the first Extract or Save & rate.
// Pure module (the ping is passed in) so node:test can drive it with fake timers.

export const DEFAULT_INTERVAL_MS = 60_000;
/** After a failed ping (Fly refused a start, a timeout), try again this soon instead of a full interval. */
export const RETRY_MS = 10_000;
export const MAX_RETRIES = 6; // one minute of quick retries, then back to the normal cadence

/** Interval from KEEP_WARM_INTERVAL_MS; "0" turns keep-warm off. */
export function keepWarmInterval(env: Record<string, string | undefined>): number {
  const raw = env.KEEP_WARM_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_INTERVAL_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_INTERVAL_MS;
}

/**
 * Ping right away (the web machine just started, likely because someone is signing in), then every
 * `intervalMs` for as long as this process runs. A ping that resolves `false` or rejects is retried
 * every RETRY_MS, up to MAX_RETRIES in a row. When Fly stops the idle web machine the pings stop
 * too, so the services go back to sleep a few minutes later. Returns a function that stops it.
 */
export function startKeepWarm(
  ping: () => Promise<boolean | void>,
  intervalMs: number,
  retry: { ms: number; max: number } = { ms: RETRY_MS, max: MAX_RETRIES },
): () => void {
  if (!intervalMs) return () => {};
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const run = async () => {
    const ok = await ping().then((r) => r !== false, () => false);
    if (stopped) return;
    if (ok) {
      retries = 0;
    } else if (!retryTimer && retries < retry.max) {
      retries++;
      retryTimer = setTimeout(() => { retryTimer = null; void run(); }, retry.ms);
      retryTimer.unref?.();
    }
  };

  void run();
  const timer = setInterval(() => { if (!retryTimer) void run(); }, intervalMs); // a retry is already on its way
  timer.unref?.(); // never keeps the process alive on its own
  return () => {
    stopped = true;
    clearInterval(timer);
    if (retryTimer) clearTimeout(retryTimer);
  };
}
