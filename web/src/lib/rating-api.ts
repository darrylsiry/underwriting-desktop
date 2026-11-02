import { errorDetailOf } from "./service-errors";
import { RATING_SERVICE_URL, ratingAuthHeaders } from "./services";
import { scheduleMod, type RatingInputs, type ScheduleItem } from "./worksheet";
import type { Rating } from "./worksheets";

/**
 * Longer than a Fly cold start: with min_machines_running = 0 the first call after a quiet spell
 * waits for the machine, and keep-warm doesn't always get there first (CR-041).
 */
export const RATING_TIMEOUT_MS = 15_000;

/** A failed rating call. `status` is the HTTP status, or null when the service didn't answer at all. */
export class RatingServiceError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "RatingServiceError";
  }

  /** The inputs themselves were refused (a 4xx), as opposed to the service being down or mid-restart. */
  get rejectedInputs(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500;
  }
}

/**
 * POST to the rating service and return the parsed JSON. The body is read as text first so a
 * non-JSON reply (an HTML 502 from the proxy while the machine starts) becomes a readable error
 * instead of a SyntaxError (CR-037).
 */
async function ratingPost<T>(path: string, body: unknown, actor?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RATING_SERVICE_URL}${path}`, {
      method: "POST", body: JSON.stringify(body),
      // Who is acting travels in a header the service trusts from us (SEC-002), not in the body.
      headers: { "Content-Type": "application/json", ...(actor ? { "x-uw-user": actor } : {}), ...ratingAuthHeaders() },
      signal: AbortSignal.timeout(RATING_TIMEOUT_MS),
    });
  } catch (err) {
    // UX-008: say what the failure did not do.
    throw new RatingServiceError(`Rating service unreachable (${(err as Error).message}). Your inputs are saved; the last premium is kept.`, null);
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = errorDetailOf(text) ?? "no details";
    throw new RatingServiceError(res.status < 500 ? `Rating: ${detail}` : `Rating service error ${res.status}: ${detail}`, res.status);
  }
  return JSON.parse(text) as T;
}

export type RateVersion = {
  id: number; label: string; status: string; notes: string; created_by: string; created_at: string; activated_at: string | null; based_on: number | null;
};

/** Every rate version the rating service holds. */
export async function listRateVersions(): Promise<RateVersion[]> {
  let res: Response;
  try {
    res = await fetch(`${RATING_SERVICE_URL}/rate-versions`, { cache: "no-store", signal: AbortSignal.timeout(RATING_TIMEOUT_MS) });
  } catch (err) {
    throw new RatingServiceError(`Rating service unreachable (${(err as Error).message}). Try again shortly.`, null);
  }
  // Status null below 500: a refused listing says nothing about the inputs, so it must not read as `rejectedInputs`.
  if (!res.ok) throw new RatingServiceError(`Rating service returned ${res.status} listing rate versions`, res.status >= 500 ? res.status : null);
  return res.json();
}

/** The rating service's id for a rate version label ("2026.1"), or null if it has no such version. */
export async function rateVersionId(label: string): Promise<number | null> {
  return (await listRateVersions()).find((v) => v.label === label)?.id ?? null;
}

/**
 * Rate inputs and a schedule: on the active rate version, or on a specific one when `versionId`
 * is given (any version the service still holds, so an expiring policy can be re-rated on the
 * rates it was written on). `at` dates the service's log entry then instead of now (seeded history).
 */
export async function rateOn(
  inputs: RatingInputs, schedule: ScheduleItem[], versionId: number | null, reference: string, actor: string, at: Date | null = null,
): Promise<Rating> {
  return ratingPost<Rating>("/rate", {
    ...inputs, schedule_mod: scheduleMod(schedule), ...(versionId ? { rate_version_id: versionId } : {}),
    reference, rated_at: at?.toISOString(),
  }, actor);
}
