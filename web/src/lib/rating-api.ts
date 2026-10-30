import { RATING_SERVICE_URL } from "./services";
import { scheduleMod, type RatingInputs, type ScheduleItem } from "./worksheet";
import type { Rating } from "./worksheets";

/** The rating service's id for a rate version label ("2026.1"), or null if it has no such version. */
export async function rateVersionId(label: string): Promise<number | null> {
  const res = await fetch(`${RATING_SERVICE_URL}/rate-versions`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Rating service returned ${res.status} listing rate versions`);
  const versions: { id: number; label: string }[] = await res.json();
  return versions.find((v) => v.label === label)?.id ?? null;
}

/**
 * Rate inputs and a schedule, on a specific rate version when `versionId` is given (any version
 * the service still holds, so an expiring policy can be re-rated on the rates it was written on).
 */
export async function rateOn(
  inputs: RatingInputs, schedule: ScheduleItem[], versionId: number | null, reference: string, actor: string,
): Promise<Rating> {
  const res = await fetch(`${RATING_SERVICE_URL}/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...inputs, schedule_mod: scheduleMod(schedule), ...(versionId ? { rate_version_id: versionId } : {}),
      reference, requested_by: actor,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Rating: ${typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)}`);
  return body as Rating;
}
