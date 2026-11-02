// What a sign-in request tells us about where it came from, and the sign-in report built from the
// recorded events. Pure module (no database, no fetch) so node:test can load it; login-events.ts
// does the recording and the geo lookup.

export type Geo = {
  country?: string; country_code?: string; region?: string; city?: string;
  timezone?: string; isp?: string; asn?: number; lat?: number; lon?: number;
};

export type LoginMethod = "signin" | "api";

export type LoginEvent = {
  id: number;
  occurred_at: Date;
  username: string;
  success: boolean;
  method: LoginMethod;
  ip: string | null;
  user_agent: string | null;
  accept_language: string | null;
  edge_region: string | null;
  geo: Geo | null;
  geo_source: string | null;
};

export type ClientInfo = { ip: string | null; user_agent: string | null; accept_language: string | null; edge_region: string | null };

export type TrustEnv = Record<string, string | undefined>;   // FLY_APP_NAME, TRUSTED_PROXY

/** The name a failed attempt is recorded under when it doesn't name a login we have. */
export const UNKNOWN_USER = "(unknown user)";

const LANGUAGE_TAG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;
const LANGUAGE_ENTRY = /^(\*|[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*)(;\s*q=[0-9.]{1,5})?$/;

/** An Accept-Language header reduced to its well-formed entries, or null unless it starts with a language tag (CR-090). */
export function cleanLanguages(header: string | null): string | null {
  const entries = (header ?? "").split(",").map((e) => e.trim());
  if (!LANGUAGE_TAG.test(entries[0].split(";")[0].trim())) return null;
  return entries.filter((e) => LANGUAGE_ENTRY.test(e)).join(",").slice(0, 100) || null;
}

/** The first language of a stored value, for display; "" for anything else (a row from before that check). */
export function languageTag(stored: string | null): string {
  const first = (stored ?? "").split(",")[0].split(";")[0].trim();
  return LANGUAGE_TAG.test(first) ? first : "";
}

/**
 * The client as the request headers describe it. Address headers are only believed from a proxy
 * that overwrites them (SEC-033): Fly-Client-IP on Fly (FLY_APP_NAME is set there and a client can't
 * forge the header past Fly's proxy), and X-Forwarded-For / X-Real-IP only when TRUSTED_PROXY=1 says
 * such a proxy is in front. Otherwise the row records no address rather than one the client chose;
 * `untrusted` says an address header was present but ignored.
 */
export function clientInfo(h: { get(name: string): string | null }, env: TrustEnv = process.env): ClientInfo & { untrusted: boolean } {
  const fly = env.FLY_APP_NAME ? h.get("fly-client-ip")?.trim() || null : null;
  const forwarded = env.TRUSTED_PROXY === "1" ? h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip")?.trim() || null : null;
  const ip = fly || forwarded;
  const untrusted = !ip && !!(h.get("fly-client-ip") || h.get("x-forwarded-for") || h.get("x-real-ip"));
  return {
    ip: ip ? ip.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "").slice(0, 45) : null,
    user_agent: h.get("user-agent")?.slice(0, 500) || null,
    accept_language: cleanLanguages(h.get("accept-language")),
    edge_region: h.get("fly-region")?.trim().slice(0, 20) || null,
    untrusted,
  };
}

/** What a row keeps about the client. An attempt under no real login is anonymous traffic, so none of its own text is kept (CR-090). */
export function recordedClient(username: string, h: { get(name: string): string | null }, env: TrustEnv = process.env): ClientInfo & { untrusted: boolean } {
  const c = clientInfo(h, env);
  return username === UNKNOWN_USER ? { ...c, user_agent: null, accept_language: null } : c;
}

/**
 * The network an address belongs to, for limits: an IPv4 address itself, and an IPv6 address's /64,
 * because one sender holds that whole block and can use a new address for every request.
 */
export function addressKey(ip: string | null): string | null {
  if (!ip?.includes(":")) return ip;
  const [head, tail] = ip.split("%")[0].toLowerCase().split("::");
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const [h, t] = [groups(head), groups(tail)];
  const zeros = tail === undefined ? [] : Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0");
  return `${[...h, ...zeros, ...t].slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Failed sign-ins allowed from one network before it has to wait (CR-090). An address we can't name isn't limited. */
export const FAILED_SIGNINS = { attempts: 20, windowMs: 15 * 60_000 };
const FAILED_SIGNINS_TRACKED = 5_000;

export type FailureWindows = Map<string, { start: number; count: number }>;

export function signInLimited(seen: FailureWindows, ip: string | null, now = Date.now()): boolean {
  const key = addressKey(ip);
  const w = key ? seen.get(key) : undefined;
  return !!w && now - w.start < FAILED_SIGNINS.windowMs && w.count >= FAILED_SIGNINS.attempts;
}

export function noteFailedSignIn(seen: FailureWindows, ip: string | null, now = Date.now()): void {
  const key = addressKey(ip);
  if (!key) return;
  const w = seen.get(key);
  if (w && now - w.start < FAILED_SIGNINS.windowMs) { w.count++; return; }
  if (seen.size >= FAILED_SIGNINS_TRACKED) seen.clear();
  seen.set(key, { start: now, count: 1 });
}

/** Tries a row gets at a location before the report stops asking (CR-091). */
export const GEO_MAX_ATTEMPTS = 3;

/**
 * Whether a failed lookup would fail the same way next time. The service being down, slow, busy or
 * over its limit is worth another try; what it said about this address otherwise won't change.
 */
export function geoFailureIsFinal(source: string): boolean {
  return !/unreachable|unreadable|HTTP (429|5\d\d)|limit|quota|too many/i.test(source);
}

const GEO_TEXT_MAX = 80;
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, GEO_TEXT_MAX) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * A geo lookup's reply reduced to what we store: known fields only, strings trimmed to 80
 * characters, numbers only where a number is expected (SEC-033). The vendor's JSON is untrusted
 * input like any other; nothing else of it is kept. Null when it says nothing usable.
 */
export function sanitizeGeo(j: unknown): Geo | null {
  if (!j || typeof j !== "object") return null;
  const r = j as Record<string, unknown>;
  const tz = r.timezone && typeof r.timezone === "object" ? (r.timezone as Record<string, unknown>).id : r.timezone;
  const conn = r.connection && typeof r.connection === "object" ? (r.connection as Record<string, unknown>) : {};
  const geo: Geo = {
    country: text(r.country), country_code: text(r.country_code)?.slice(0, 3), region: text(r.region), city: text(r.city),
    timezone: text(tz), isp: text(conn.isp) ?? text(conn.org), asn: num(conn.asn), lat: num(r.latitude), lon: num(r.longitude),
  };
  for (const k of Object.keys(geo) as (keyof Geo)[]) if (geo[k] === undefined) delete geo[k];
  return Object.keys(geo).length ? geo : null;
}

/** False for loopback, private and link-local ranges: a geo lookup can't place them. */
export function isPublicIp(ip: string | null): ip is string {
  if (!ip) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)) return false;
  if (/^(::1|::|fc|fd|fe80)/i.test(ip)) return false;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^[0-9a-f:]+$/i.test(ip);
}

/** "San Jose, California, US" or as much of it as the lookup gave; "" with no geo. */
export function place(geo: Geo | null | undefined): string {
  if (!geo) return "";
  return [geo.city, geo.region, geo.country_code ?? geo.country].filter((s, i, a) => s && a.indexOf(s) === i).join(", ");
}

/**
 * An address short enough for a table cell: IPv4 and short IPv6 addresses as they are, a long IPv6
 * one as its first two groups and its last (`2600:1702:…:9d45`), which keeps the network and still
 * tells devices apart. The tables show the full address on hover.
 */
export function shortIp(ip: string): string {
  if (ip.includes(".") || ip.length <= 19) return ip;
  const groups = ip.split(":");
  return groups.length < 4 ? ip : `${groups[0]}:${groups[1]}:…:${groups[groups.length - 1]}`;
}

const withOs = (browser: string, ua: string) => {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
};

/** The client when `ua` names one we know, built only from these words and version digits; else null. */
function knownBrowser(ua: string): string | null {
  if (/^curl\//.test(ua)) return "curl";
  const client = /python-requests|httpx|node-fetch|undici|Go-http-client|okhttp/i.exec(ua)?.[0];
  if (client) return client;
  const browser = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
    : /OPR\/(\d+)/.exec(ua) ? `Opera ${/OPR\/(\d+)/.exec(ua)![1]}`
    : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
    : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
    : /Version\/(\d+).*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
    : null;
  return browser && withOs(browser, ua);
}

/** A short browser/OS label from a user-agent string, for the tables; the full string stays in the row. */
export function browserLabel(ua: string | null): string {
  if (!ua) return "";
  return knownBrowser(ua) ?? withOs(ua.split(" ")[0].slice(0, 30), ua);
}

export type UserSummary = {
  username: string;
  logins: number;            // successful sign-ins
  failures: number;
  first_seen: Date | null;
  last_seen: Date | null;
  last_ip: string | null;
  last_place: string;
  ips: string[];             // distinct, most recent first
  places: string[];          // distinct, most recent first
  methods: LoginMethod[];
};

export type LoginReport = {
  generated_at: Date;
  window_hours: number;
  since: Date;
  last_24h: { logins: number; failures: number; users: UserSummary[]; events: LoginEvent[] };
  all_time: { logins: number; failures: number; users: UserSummary[]; events: LoginEvent[]; events_total: number; earliest: Date | null };
  never_signed_in: string[];  // configured logins with no successful sign-in on record
};

const byLatestSignIn = (a: UserSummary, b: UserSummary) => (b.last_seen?.getTime() ?? 0) - (a.last_seen?.getTime() ?? 0) || a.username.localeCompare(b.username);

/** One login's row of the SQL totals over login_events; the lists cover its successful sign-ins, newest first. */
export type UserTotalsRow = {
  username: string; logins: number; failures: number; first_seen: Date | null; last_seen: Date | null;
  ips: (string | null)[] | null; geos: (Geo | null)[] | null; methods: LoginMethod[] | null;
};

/** The same summaries as `summarize`, from SQL totals, so they cover the whole table however large (CR-115). */
export function summaryFromTotals(rows: UserTotalsRow[]): UserSummary[] {
  const distinct = <T>(list: (T | null | "")[]) => [...new Set(list.filter(Boolean))] as T[];
  return rows.map((r): UserSummary => ({
    username: r.username, logins: r.logins, failures: r.failures, first_seen: r.first_seen, last_seen: r.last_seen,
    last_ip: r.ips?.[0] ?? null, last_place: place(r.geos?.[0]),
    ips: distinct(r.ips ?? []), places: distinct((r.geos ?? []).map(place)), methods: distinct(r.methods ?? []),
  })).sort(byLatestSignIn);
}

/** Per-user totals over `events` (any order). Users sorted by most recent sign-in. */
export function summarize(events: LoginEvent[]): UserSummary[] {
  const byUser = new Map<string, UserSummary>();
  const sorted = [...events].sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
  for (const e of sorted) {
    const s = byUser.get(e.username) ?? { username: e.username, logins: 0, failures: 0, first_seen: null, last_seen: null, last_ip: null, last_place: "", ips: [], places: [], methods: [] };
    byUser.set(e.username, s);
    if (!e.success) { s.failures++; continue; }
    s.logins++;
    s.first_seen = e.occurred_at;                       // descending order: the last one seen is the earliest
    if (!s.last_seen) { s.last_seen = e.occurred_at; s.last_ip = e.ip; s.last_place = place(e.geo); }
    if (e.ip && !s.ips.includes(e.ip)) s.ips.push(e.ip);
    const p = place(e.geo);
    if (p && !s.places.includes(p)) s.places.push(p);
    if (!s.methods.includes(e.method)) s.methods.push(e.method);
  }
  return [...byUser.values()].sort(byLatestSignIn);
}

/** Where the report's recent window starts. */
export const windowStart = (now: Date, windowHours = 24) => new Date(now.getTime() - windowHours * 3_600_000);

/**
 * The report: who signed in over the last `windowHours` and over all time. `events` is what the
 * event lists draw from: every recorded event (newest first) or, past `eventsTotal`, the newest ones
 * the caller fetched. The caller's SQL totals (`windowUsers`, `allTimeUsers`, `earliest`) are what
 * the numbers come from, so a burst of attempts can't push real sign-ins out of them (CR-115); on
 * their own the events stand in for them.
 */
export function buildReport(events: LoginEvent[], configured: string[], opts: {
  now?: Date; windowHours?: number; eventsTotal?: number; listLimit?: number;
  windowUsers?: UserSummary[]; allTimeUsers?: UserSummary[]; earliest?: Date | null;
} = {}): LoginReport {
  const now = opts.now ?? new Date();
  const windowHours = opts.windowHours ?? 24;
  const since = windowStart(now, windowHours);
  const all = [...events].sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
  const recent = all.filter((e) => e.occurred_at >= since);
  const recentUsers = opts.windowUsers ?? summarize(recent);
  const allUsers = opts.allTimeUsers ?? summarize(all);
  const total = (users: UserSummary[], k: "logins" | "failures") => users.reduce((n, u) => n + u[k], 0);
  const seen = new Set(allUsers.filter((u) => u.logins > 0).map((u) => u.username));
  return {
    generated_at: now, window_hours: windowHours, since,
    last_24h: { logins: total(recentUsers, "logins"), failures: total(recentUsers, "failures"), users: recentUsers, events: recent },
    all_time: {
      logins: total(allUsers, "logins"), failures: total(allUsers, "failures"), users: allUsers,
      events: all.slice(0, opts.listLimit ?? 200), events_total: opts.eventsTotal ?? all.length,
      earliest: opts.earliest !== undefined ? opts.earliest : all.length ? all[all.length - 1].occurred_at : null,
    },
    never_signed_in: configured.filter((u) => !seen.has(u)).sort(),
  };
}

const when = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");

// The Markdown is read by a scheduled Claude task, and failed attempts come from anyone: nothing a
// sender wrote goes in as it was sent (CR-090). Free text stays on its one table cell; a browser,
// a language, an address and a region show only when they are what they claim to be.
const esc = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
const token = (s: string | null) => (s && /^[A-Za-z0-9.:-]{1,45}$/.test(s) ? s : "—");
const reportBrowser = (ua: string | null) => (ua ? knownBrowser(ua) ?? "other" : "—");

function usersTable(users: UserSummary[]): string {
  if (!users.length) return "_No sign-ins._\n";
  const lines = ["| User | Sign-ins | Failed | First | Last | Last IP | Last location | All IPs | All locations | Via |", "|---|---:|---:|---|---|---|---|---|---|---|"];
  for (const u of users) {
    lines.push(`| ${esc(u.username)} | ${u.logins} | ${u.failures} | ${when(u.first_seen)} | ${when(u.last_seen)} | ${token(u.last_ip)} | ${esc(u.last_place) || "—"} | ${u.ips.map(token).join(", ") || "—"} | ${esc(u.places.join("; ")) || "—"} | ${u.methods.join(", ") || "—"} |`);
  }
  return lines.join("\n") + "\n";
}

function eventsTable(events: LoginEvent[]): string {
  if (!events.length) return "_No events._\n";
  const lines = ["| When (UTC) | User | Result | Via | IP | Location | ISP | Edge | Browser | Language |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const e of events) {
    lines.push(`| ${when(e.occurred_at)} | ${esc(e.username)} | ${e.success ? "ok" : "FAILED"} | ${e.method} | ${token(e.ip)} | ${esc(place(e.geo)) || (e.geo_source ? esc(e.geo_source) : "—")} | ${esc(e.geo?.isp ?? "") || "—"} | ${token(e.edge_region)} | ${reportBrowser(e.user_agent)} | ${languageTag(e.accept_language) || "—"} |`);
  }
  return lines.join("\n") + "\n";
}

/** The report as Markdown: what scripts/login-report.sh writes each day. */
export function reportMarkdown(r: LoginReport, origin = ""): string {
  const out: string[] = [];
  out.push(`# Sign-in report · ${r.generated_at.toISOString().slice(0, 10)}`, "");
  out.push(`Generated ${when(r.generated_at)}${origin ? ` from ${origin}` : ""}. Records since ${r.all_time.earliest ? when(r.all_time.earliest) : "the sign-in log started (nothing recorded yet)"}.`, "");
  out.push(`## Last ${r.window_hours} hours (since ${when(r.since)})`, "");
  out.push(`${r.last_24h.logins} successful sign-in${r.last_24h.logins === 1 ? "" : "s"} by ${r.last_24h.users.filter((u) => u.logins).length} user${r.last_24h.users.filter((u) => u.logins).length === 1 ? "" : "s"}; ${r.last_24h.failures} failed attempt${r.last_24h.failures === 1 ? "" : "s"}.`, "");
  out.push("### Who signed in", "", usersTable(r.last_24h.users));
  const inWindow = r.last_24h.logins + r.last_24h.failures;
  out.push(`### Every attempt${inWindow > r.last_24h.events.length ? ` (newest ${r.last_24h.events.length} of ${inWindow}; the CSV has them all)` : ""}`, "", eventsTable(r.last_24h.events));
  out.push("## All time", "");
  out.push(`${r.all_time.logins} successful sign-in${r.all_time.logins === 1 ? "" : "s"} by ${r.all_time.users.filter((u) => u.logins).length} user${r.all_time.users.filter((u) => u.logins).length === 1 ? "" : "s"}; ${r.all_time.failures} failed attempt${r.all_time.failures === 1 ? "" : "s"}.`, "");
  if (r.never_signed_in.length) out.push(`Logins that have never signed in: ${r.never_signed_in.join(", ")}.`, "");
  out.push("### Who has signed in", "", usersTable(r.all_time.users));
  out.push(`### Latest attempts${r.all_time.events_total > r.all_time.events.length ? ` (newest ${r.all_time.events.length} of ${r.all_time.events_total}; the CSV has them all)` : ""}`, "", eventsTable(r.all_time.events));
  out.push("Via: `signin` is the sign-in page; `api` is an HTTP Basic login on the API or MCP endpoint, recorded once per login, address and hour. Location and ISP are looked up from the IP (ipwho.is); a private or local address has none.", "");
  return out.join("\n");
}

export const EVENT_CSV_HEADER = ["occurred_at_utc", "username", "success", "method", "ip", "country", "region", "city", "timezone", "isp", "edge_region", "browser", "accept_language", "user_agent", "geo_source"];

/** Sign-in headers are a stranger's text: a cell a spreadsheet would run as a formula starts with a quote instead (CR-090, CR-071). */
const csvText = (s: string | null) => (s && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export function eventCsvRow(e: LoginEvent): (string | number | boolean | null)[] {
  return [e.occurred_at.toISOString(), e.username, e.success, e.method, csvText(e.ip), e.geo?.country ?? null, e.geo?.region ?? null, e.geo?.city ?? null,
    e.geo?.timezone ?? null, e.geo?.isp ?? null, csvText(e.edge_region), csvText(browserLabel(e.user_agent)) || null, csvText(e.accept_language), csvText(e.user_agent), csvText(e.geo_source)];
}
