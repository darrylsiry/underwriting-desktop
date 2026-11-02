import { after } from "next/server";
import { policyDb } from "./db";
import { loadUsers } from "./basic-auth";
import { buildReport, clientInfo, isPublicIp, sanitizeGeo, type Geo, type LoginEvent, type LoginMethod, type LoginReport } from "./login-meta";

// Recording sign-ins (policy.login_events) and the sign-in report over them. The geo lookup
// happens after the response is sent, so signing in never waits on it; rows it missed are
// filled in the next time the report runs.

const GEO_TIMEOUT_MS = 2_500;

type Headers = { get(name: string): string | null };

/** One row for this attempt. Returns the row id. The geo lookup follows after the response. */
export async function recordLogin(username: string, success: boolean, method: LoginMethod, headers: Headers): Promise<number> {
  const c = clientInfo(headers);
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
 * Note an HTTP Basic login, at most once per hour per login and address. The middleware calls this
 * for every request it let in on HTTP Basic; a browser session calling the API (the Try-it links) is
 * not a new login.
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
    await policyDb.query("UPDATE login_events SET geo = $2, geo_source = $3 WHERE id = $1", [id, geo ? JSON.stringify(geo) : null, source]);
  } catch (err) {
    console.error("login-events: geo lookup not saved", err);
  }
}

const ALL_TIME_FETCH = 5_000;

const toEvent = (r: LoginEvent & { id: string | number }): LoginEvent => ({ ...r, id: Number(r.id), occurred_at: new Date(r.occurred_at) });

/**
 * The sign-in report. Rows that still lack a location (the lookup failed or timed out at sign-in)
 * are looked up now, a few at a time, so the report keeps improving as the service allows.
 */
export async function loginReport(opts: { now?: Date; windowHours?: number; listLimit?: number } = {}): Promise<LoginReport> {
  const { rows: missing } = await policyDb.query<{ id: number; ip: string }>(
    "SELECT id, ip FROM login_events WHERE geo IS NULL AND ip IS NOT NULL AND (geo_source IS NULL OR geo_source LIKE 'ipwho.is%') ORDER BY id DESC LIMIT 10");
  await Promise.all(missing.filter((r) => isPublicIp(r.ip)).map((r) => fillGeo(Number(r.id), r.ip)));
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    policyDb.query<LoginEvent & { id: string }>("SELECT * FROM login_events ORDER BY occurred_at DESC, id DESC LIMIT $1", [ALL_TIME_FETCH]),
    policyDb.query<{ total: string }>("SELECT count(*)::text AS total FROM login_events"),
  ]);
  return buildReport(rows.map(toEvent), [...loadUsers(process.env).keys()], { ...opts, eventsTotal: Number(total) });
}

/** Every event, newest first, for the CSV download. */
export async function allLoginEvents(): Promise<LoginEvent[]> {
  const { rows } = await policyDb.query<LoginEvent & { id: string }>("SELECT * FROM login_events ORDER BY occurred_at DESC, id DESC");
  return rows.map(toEvent);
}
