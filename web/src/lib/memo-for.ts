// Pure module for node:test.

/**
 * Remember an async answer for `ms`, and share one call among those asking at once, so a slow or
 * stopped service costs one wait per window and not one per render (CR-085).
 */
export function memoFor<T>(ms: number, fn: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let held: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (!held || now() - held.at >= ms) held = { at: now(), value: fn() };
    return held.value;
  };
}
