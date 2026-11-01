import { policyDb } from "./db";
import type { AccessRequestInput } from "./access-requests";
import type { SendResult } from "./mailer";

// policy.access_requests (step 27): every request from the sign-in page, kept whether or not the
// email went out, and the counts the throttle needs.

export type AccessRequestRow = AccessRequestInput & {
  id: number; created_at: Date; ip: string | null; emailed_at: Date | null; email_error: string | null;
};

/** Requests from this address in the last hour, and from anyone in the last day. */
export async function recentRequestCounts(ip: string | null): Promise<{ fromAddressLastHour: number; lastDay: number }> {
  const { rows } = await policyDb.query<{ hour: number; day: number }>(
    `SELECT count(*) FILTER (WHERE ip IS NOT DISTINCT FROM $1 AND created_at > now() - interval '1 hour')::int AS hour,
            count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS day
     FROM access_requests WHERE created_at > now() - interval '1 day'`, [ip]);
  return { fromAddressLastHour: rows[0]?.hour ?? 0, lastDay: rows[0]?.day ?? 0 };
}

export async function storeAccessRequest(r: AccessRequestInput & { ip: string | null; userAgent: string | null }): Promise<number> {
  const { rows } = await policyDb.query<{ id: number }>(
    "INSERT INTO access_requests (name, email, company, ip, user_agent) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [r.name, r.email, r.company, r.ip, r.userAgent]);
  return Number(rows[0].id);
}

export async function recordEmailResult(id: number, result: SendResult): Promise<void> {
  await policyDb.query(
    result.sent ? "UPDATE access_requests SET emailed_at = now(), email_error = NULL WHERE id = $1"
      : "UPDATE access_requests SET email_error = $2 WHERE id = $1",
    result.sent ? [id] : [id, result.reason]);
}

export async function listAccessRequests(limit = 50): Promise<AccessRequestRow[]> {
  const { rows } = await policyDb.query<AccessRequestRow>(
    "SELECT id, created_at, name, email, company, ip, emailed_at, email_error FROM access_requests ORDER BY created_at DESC, id DESC LIMIT $1", [limit]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
