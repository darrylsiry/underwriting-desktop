import { after } from "next/server";
import { policyDb } from "./db";
import { loadUsers } from "./basic-auth";
import {
  buildReport, clientInfo, GEO_MAX_ATTEMPTS, geoFailureIsFinal, isPublicIp, noteFailedSignIn, recordedClient, sanitizeGeo, signInLimited, summaryFromTotals, windowStart,
  type FailureWindows, type Geo, type LoginEvent, type LoginMethod, type LoginReport, type UserSummary, type UserTotalsRow,
} from "./login-meta";

// Recording sign-ins (policy.login_events) and the sign-in report over them. The geo lookup
// happens after the response is sent, so signing in never waits on it; rows it missed are
// retried a few times, after a report has gone out.

const GEO_TIMEOUT_MS = 2_500;
const GEO_RETRY_BATCH = 10;
const GEO_RETRY_EVERY_MS = 10 * 60_000;

type Headers = { get(name: string): string | null };

/** One row for this attempt. Returns the row id. The geo lookup follows after the response. */
export async function recordLogin(username: string, success: boolean, method: LoginMethod, headers: Headers): Promise<number> {
  const c = recordedClient(username, headers);
  const { rows } = await policyDb.query<{ id: number }>(
    `INSERT INTO login_events (username, success, method, ip, user_agent, accept_language, edge_region, geo_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [username, success, method, c.ip, c.user_agent, c.accept_language, c.edge_region,
     c.ip ? null : c.untrusted ? "address header ignored (no trusted proxy; set TRUSTED_PROXY=1 behind one)" : "no client address (local)"]);
  const id = Number(rows[0].id);
  if (isPublicIp(c.ip)) {
    const ip = c.ip;
    try { after(() => fillGeo(id, ip)); } catch { void fillGeo(id, ip); }   // after() needs a request scope; outside one, just run it
  } else if (c.ip) {
    await policyDb.query("UPDATE login_events SET geo_source = 'private address' WHERE id = $1", [id]);
  }
  return id;
}

// API callers send their login on every request; one row per login, address and hour is enough
// to show that they were here. The window is per process (a restart writes one extra row); it
// lives on globalThis because `next dev` re-instantiates modules between requests (as db.ts does).
const apiSeen = ((globalThis as unknown as { __apiLoginsSeen?: Map<string, number> }).__apiLoginsSeen ??= new Map<string, number>());

/**
 * Note an HTTP Basic login on /api (the GL API, the MCP server), at most once per hour per login
 * and address. A browser session calling the API (the Try-it links) is not a new login.
 */
export function noteApiLogin(username: string | null, headers: Headers): void {
  if (!username || !headers.get("authorization")?.startsWith("Basic ")) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `${username}\n${clientInfo(headers).ip ?? ""}\n${headers.get("user-agent") ?? ""}`;
  if (apiSeen.get(key) === hour) return;
  apiSeen.set(key, hour);
  if (apiSeen.size > 5_000) apiSeen.clear();
  recordLogin(username, true, "api", headers).catch((err) => console.error("login-events: api login not recorded", err));
}

// Failed sign-ins per network (CR-090), per process like apiSeen: enough to stop a flood filling
// the sign-in log, or a run of guesses, and a restart only forgets at most one window.
const failedSignIns = ((globalThis as unknown as { __failedSignIns?: FailureWindows }).__failedSignIns ??= new Map());

/** True when this address has failed too often lately: the attempt is refused unchecked and unrecorded. */
export const tooManyFailedSignIns = (ip: string | null) => signInLimited(failedSignIns, ip);
export const countFailedSignIn = (ip: string | null) => noteFailedSignIn(failedSignIns, ip);

/** Where an address is, from ipwho.is (keyless, no account). Null when the service can't say. */
export async function lookupGeo(ip: string): Promise<{ geo: Geo | null; source: string }> {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(GEO_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return { geo: null, source: `ipwho.is HTTP ${res.status}` };
    const j = await res.json() as { success?: boolean; message?: string };
    if (!j || typeof j !== "object") return { geo: null, source: "ipwho.is: unreadable reply" };
    if (!j.success) return { geo: null, source: `ipwho.is: ${typeof j.message === "string" ? j.message.slice(0, 80) : "no result"}` };
    const geo = sanitizeGeo(j);   // the vendor's JSON is untrusted input: known fields, bounded (SEC-033)
    return geo ? { source: "ipwho.is", geo } : { geo: null, source: "ipwho.is: empty result" };
  } catch (err) {
    return { geo: null, source: `ipwho.is unreachable (${(err as Error).name})` };
  }
}

async function fillGeo(id: number, ip: string): Promise<void> {
  try {
    const { geo, source } = await lookupGeo(ip);
    // A failure that won't change uses up the row's tries at once (CR-091).
    await policyDb.query("UPDATE login_events SET geo = $2, geo_source = $3, geo_attempts = GREATEST(geo_attempts + 1, $4::int) WHERE id = $1",
      [id, geo ? JSON.stringify(geo) : null, source, !geo && geoFailureIsFinal(source) ? GEO_MAX_ATTEMPTS : 0]);
  } catch (err) {
    console.error("login-events: geo lookup not saved", err);
  }
}

/** Look up a few rows still missing a location. Never throws: it runs after the response has gone. */
async function fillMissingGeo(): Promise<void> {
  try {
    const { rows } = await policyDb.query<{ id: string; ip: string }>(
      `SELECT id, ip FROM login_events
        WHERE geo IS NULL AND ip IS NOT NULL AND geo_attempts < $1 AND (geo_source IS NULL OR geo_source LIKE 'ipwho.is%')
        ORDER BY id DESC LIMIT $2`, [GEO_MAX_ATTEMPTS, GEO_RETRY_BATCH]);
    const unplaceable = rows.filter((r) => !isPublicIp(r.ip)).map((r) => r.id);
    if (unplaceable.length) await policyDb.query("UPDATE login_events SET geo_attempts = $2 WHERE id = ANY($1::bigint[])", [unplaceable, GEO_MAX_ATTEMPTS]);
    await Promise.all(rows.filter((r) => isPublicIp(r.ip)).map((r) => fillGeo(Number(r.id), r.ip)));
  } catch (err) {
    console.error("login-events: geo retry failed", err);
  }
}

const geoRetry = ((globalThis as unknown as { __geoRetry?: { at: number } }).__geoRetry ??= { at: 0 });

/**
 * Rows that still lack a location (the lookup failed or timed out at sign-in) are looked up again,
 * so the report keeps improving as the service allows: after the response, never holding up a
 * render, at most one batch every ten minutes, and only a few tries per row (CR-091).
 */
function retryMissingGeo(now = Date.now()): void {
  if (now - geoRetry.at < GEO_RETRY_EVERY_MS) return;
  geoRetry.at = now;
  try { after(fillMissingGeo); } catch { void fillMissingGeo(); }   // after() needs a request scope; outside one, just run it
}

/** The most rows the event lists draw from. Every number in the report comes from SQL totals instead (CR-115). */
const EVENTS_FETCH = 5_000;
const EVENT_COLUMNS = "id, occurred_at, username, success, method, ip, user_agent, accept_language, edge_region, geo, geo_source";

const toEvent = (r: LoginEvent & { id: string | number }): LoginEvent => ({ ...r, id: Number(r.id), occurred_at: new Date(r.occurred_at) });

/** Per-login totals over the whole table, or since `since`. */
async function userTotals(since: Date | null): Promise<UserSummary[]> {
  const { rows } = await policyDb.query<UserTotalsRow>(
    `SELECT username,
            count(*) FILTER (WHERE success)::int AS logins,
            count(*) FILTER (WHERE NOT success)::int AS failures,
            min(occurred_at) FILTER (WHERE success) AS first_seen,
            max(occurred_at) FILTER (WHERE success) AS last_seen,
            array_agg(ip ORDER BY occurred_at DESC, id DESC) FILTER (WHERE success) AS ips,
            jsonb_agg(geo ORDER BY occurred_at DESC, id DESC) FILTER (WHERE success) AS geos,
            array_agg(method ORDER BY occurred_at DESC, id DESC) FILTER (WHERE success) AS methods
       FROM login_events
      WHERE $1::timestamptz IS NULL OR occurred_at >= $1
      GROUP BY username`, [since]);
  return summaryFromTotals(rows);
}

/** The sign-in report. Rows missing a location are retried after it has gone out. */
export async function loginReport(opts: { now?: Date; windowHours?: number; listLimit?: number } = {}): Promise<LoginReport> {
  retryMissingGeo();
  const now = opts.now ?? new Date();
  const [{ rows }, { rows: [{ total, earliest }] }, windowUsers, allTimeUsers] = await Promise.all([
    policyDb.query<LoginEvent & { id: string }>(`SELECT ${EVENT_COLUMNS} FROM login_events ORDER BY occurred_at DESC, id DESC LIMIT $1`, [EVENTS_FETCH]),
    policyDb.query<{ total: string; earliest: Date | null }>("SELECT count(*)::text AS total, min(occurred_at) AS earliest FROM login_events"),
    userTotals(windowStart(now, opts.windowHours)),
    userTotals(null),
  ]);
  return buildReport(rows.map(toEvent), [...loadUsers(process.env).keys()], { ...opts, now, eventsTotal: Number(total), earliest, windowUsers, allTimeUsers });
}

/** Every event, newest first, for the CSV download. */
export async function allLoginEvents(): Promise<LoginEvent[]> {
  const { rows } = await policyDb.query<LoginEvent & { id: string }>(`SELECT ${EVENT_COLUMNS} FROM login_events ORDER BY occurred_at DESC, id DESC`);
  return rows.map(toEvent);
}
