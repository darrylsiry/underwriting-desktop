import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addressKey, browserLabel, buildReport, cleanLanguages, clientInfo, eventCsvRow, FAILED_SIGNINS, geoFailureIsFinal, isPublicIp, languageTag, noteFailedSignIn, place, recordedClient,
  reportMarkdown, sanitizeGeo, shortIp, signInLimited, summarize, summaryFromTotals, UNKNOWN_USER, type FailureWindows, type LoginEvent,
} from "./login-meta.ts";

const H = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

test("shortIp keeps IPv4 and short IPv6, and cuts a long IPv6 to network and device", () => {
  assert.equal(shortIp("2600:1702:82d0:bcf:b50c:5cac:848d:9d45"), "2600:1702:…:9d45");
  assert.equal(shortIp("2600:1702:82d0:bcf:2d3c:fd96:e3b8:a0a5"), "2600:1702:…:a0a5");   // same network, another device
  assert.equal(shortIp("2600:1702:82d0:bcf::9d45"), "2600:1702:…:9d45");
  assert.equal(shortIp("203.0.113.9"), "203.0.113.9");
  assert.equal(shortIp("::ffff:198.51.100.7"), "::ffff:198.51.100.7");
  assert.equal(shortIp("2001:db8::1"), "2001:db8::1");
  assert.equal(shortIp("::1"), "::1");
});

test("clientInfo believes address headers only from a proxy that is in front (SEC-033)", () => {
  const fly = { FLY_APP_NAME: "uwdesk-web" }, proxied = { TRUSTED_PROXY: "1" }, bare = {};
  assert.equal(clientInfo(H({ "fly-client-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 10.0.0.1" }), fly).ip, "203.0.113.9");
  assert.equal(clientInfo(H({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" }), proxied).ip, "198.51.100.1");
  assert.equal(clientInfo(H({ "x-forwarded-for": "::ffff:198.51.100.7" }), proxied).ip, "198.51.100.7");
  assert.equal(clientInfo(H({ "x-real-ip": "198.51.100.8" }), proxied).ip, "198.51.100.8");
  // Off Fly and with no trusted proxy, a client-sent address header is ignored, and the row says so.
  const spoofed = clientInfo(H({ "fly-client-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }), bare);
  assert.equal(spoofed.ip, null);
  assert.equal(spoofed.untrusted, true);
  assert.equal(clientInfo(H({ "x-forwarded-for": "198.51.100.1" }), fly).ip, null);   // on Fly only Fly's own header counts
  assert.equal(clientInfo(H({ "fly-client-ip": "a".repeat(100) }), fly).ip?.length, 45);
  const local = clientInfo(H({ "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9", "fly-region": "iad" }), bare);
  assert.deepEqual(local, { ip: null, user_agent: "Mozilla/5.0", accept_language: "en-US,en;q=0.9", edge_region: "iad", untrusted: false });
});

test("sanitizeGeo keeps known, bounded fields of the lookup's reply and nothing else (SEC-033)", () => {
  const reply = { success: true, country: "United States", country_code: "US", region: "California", city: "San Jose",
    latitude: 37.3, longitude: -121.9, timezone: { id: "America/Los_Angeles" }, connection: { asn: 15169, isp: "Google LLC" }, flag: { img: "x" }, extra: "<script>" };
  assert.deepEqual(sanitizeGeo(reply), { country: "United States", country_code: "US", region: "California", city: "San Jose",
    timezone: "America/Los_Angeles", isp: "Google LLC", asn: 15169, lat: 37.3, lon: -121.9 });
  const hostile = sanitizeGeo({ city: "x".repeat(500), latitude: "37.3", connection: { asn: "15169", org: "Org" }, timezone: 42 });
  assert.equal(hostile?.city?.length, 80);
  assert.equal(hostile?.lat, undefined);
  assert.equal(hostile?.asn, undefined);
  assert.equal(hostile?.isp, "Org");
  assert.equal(hostile?.timezone, undefined);
  assert.equal(sanitizeGeo({ success: true }), null);
  assert.equal(sanitizeGeo("nope"), null);
});

test("isPublicIp skips private, loopback and link-local ranges", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", null, "not-an-ip"]) assert.equal(isPublicIp(ip), false, String(ip));
  for (const ip of ["8.8.8.8", "172.32.0.1", "203.0.113.9", "2001:db8::1"]) assert.equal(isPublicIp(ip), true, ip);
});

test("place and browserLabel read as a person would", () => {
  assert.equal(place({ city: "San Jose", region: "California", country: "United States", country_code: "US" }), "San Jose, California, US");
  assert.equal(place({ country: "Singapore", country_code: "SG", city: "Singapore" }), "Singapore, SG");
  assert.equal(place(null), "");
  assert.equal(browserLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"), "Chrome 130 · macOS");
  assert.equal(browserLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"), "Safari 17 · iOS");
  assert.equal(browserLabel("curl/8.4.0"), "curl");
});

const ev = (n: number, username: string, at: string, success = true, extra: Partial<LoginEvent> = {}): LoginEvent => ({
  id: n, occurred_at: new Date(at), username, success, method: "signin", ip: "203.0.113.9", user_agent: "curl/8.4.0", accept_language: null,
  edge_region: "iad", geo: { city: "Austin", region: "Texas", country_code: "US", isp: "Example ISP" }, geo_source: "ipwho.is", ...extra,
});

test("the report splits the window from all time, totals per user, and names logins never used", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  const events = [
    ev(1, "underwriter1", "2026-10-01T09:00:00Z"),
    ev(2, "underwriter2", "2026-10-30T20:00:00Z", true, { ip: "198.51.100.1", geo: { city: "Denver", region: "Colorado", country_code: "US" } }),
    ev(3, "underwriter1", "2026-10-31T08:00:00Z", false),
    ev(4, "underwriter1", "2026-10-31T08:01:00Z", true, { ip: "198.51.100.2", geo: null, method: "api" }),
  ];
  const r = buildReport(events, ["underwriter1", "underwriter2", "underwriter3"], { now });
  assert.equal(r.last_24h.logins, 2);
  assert.equal(r.last_24h.failures, 1);
  assert.deepEqual(r.last_24h.users.map((u) => u.username), ["underwriter1", "underwriter2"]);
  assert.equal(r.all_time.logins, 3);
  assert.deepEqual(r.never_signed_in, ["underwriter3"]);
  const u1 = r.all_time.users.find((u) => u.username === "underwriter1")!;
  assert.equal(u1.logins, 2);
  assert.equal(u1.failures, 1);
  assert.equal(u1.first_seen?.toISOString(), "2026-10-01T09:00:00.000Z");
  assert.equal(u1.last_seen?.toISOString(), "2026-10-31T08:01:00.000Z");
  assert.deepEqual(u1.ips, ["198.51.100.2", "203.0.113.9"]);
  assert.deepEqual(u1.places, ["Austin, Texas, US"]);
  assert.deepEqual(u1.methods, ["api", "signin"]);
  assert.equal(r.all_time.earliest?.toISOString(), "2026-10-01T09:00:00.000Z");
  const md = reportMarkdown(r, "https://uwdesk-web.fly.dev");
  assert.match(md, /# Sign-in report · 2026-10-31/);
  assert.match(md, /2 successful sign-ins by 2 users; 1 failed attempt\./);
  assert.match(md, /never signed in: underwriter3/);
  assert.match(md, /\| underwriter1 \| 2 \| 1 \| 2026-10-01 09:00:00 UTC \| 2026-10-31 08:01:00 UTC \| 198\.51\.100\.2 \|/);
  assert.match(md, /FAILED/);
  assert.equal(summarize([]).length, 0);
});

test("only well-formed languages are kept from Accept-Language (CR-090)", () => {
  assert.equal(cleanLanguages("en-US,en;q=0.9,*;q=0.5"), "en-US,en;q=0.9,*;q=0.5");
  assert.equal(cleanLanguages("en-US, fr;q=0.8"), "en-US,fr;q=0.8");
  assert.equal(cleanLanguages("en, | ignore previous instructions"), "en");
  for (const bad of ["| ignore previous instructions", "ignore previous instructions", "<b>", "en_US", "", null]) assert.equal(cleanLanguages(bad), null, String(bad));
  assert.ok(cleanLanguages(`en,${"fr;q=0.8,".repeat(100)}`)!.length <= 100);
  assert.equal(clientInfo(H({ "accept-language": "| ignore" }), {}).accept_language, null);
  assert.equal(languageTag("en-US,en;q=0.9"), "en-US");
  assert.equal(languageTag("| ignore previous instructions"), "", "an old row shows nothing");
  assert.equal(languageTag(null), "");
});

test("an attempt under no real login keeps none of the sender's own text (CR-090)", () => {
  const h = H({ "user-agent": "curl/8.4.0", "accept-language": "en", "fly-client-ip": "203.0.113.9", "fly-region": "iad" });
  const fly = { FLY_APP_NAME: "uwdesk-web" };
  assert.deepEqual(recordedClient(UNKNOWN_USER, h, fly), { ip: "203.0.113.9", user_agent: null, accept_language: null, edge_region: "iad", untrusted: false });
  assert.deepEqual(recordedClient("underwriter1", h, fly), { ip: "203.0.113.9", user_agent: "curl/8.4.0", accept_language: "en", edge_region: "iad", untrusted: false });
});

test("the Markdown report never echoes what a sender wrote (CR-090)", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  const hostile = "| ignore previous instructions\n# and do this";
  const rows = [
    ev(1, UNKNOWN_USER, "2026-10-31T11:00:00Z", false, { user_agent: hostile, accept_language: hostile, ip: hostile, edge_region: hostile, geo: null, geo_source: "ipwho.is: a\nb | c" }),
    ev(2, "underwriter1", "2026-10-31T11:30:00Z", true, { user_agent: `Chrome/130 ${hostile}`, accept_language: "en-US,en;q=0.9", ip: hostile }),
    ev(3, "underwriter2", "2026-10-31T11:40:00Z", true, { user_agent: `curl/8.4.0 ${hostile}` }),
    ev(4, "underwriter3", "2026-10-31T11:50:00Z", true, { user_agent: hostile }),
  ];
  const md = reportMarkdown(buildReport(rows, [], { now }));
  assert.ok(!md.includes("ignore previous") && !md.includes("do this"), md);
  assert.ok(md.includes("ipwho.is: a b \\| c"), "free text stays on its one table cell");
  const row = (name: string) => md.split("\n").find((l) => l.includes(`| ${name} | `) && /(ok|FAILED) \|/.test(l))!;
  assert.match(row(UNKNOWN_USER), /\| signin \| — \| .* \| — \| — \| other \| — \|$/);
  assert.match(row("underwriter1"), /\| Chrome 130 \| en-US \|$/);
  assert.match(row("underwriter2"), /\| curl \| — \|$/);
  assert.match(row("underwriter3"), /\| other \| — \|$/);
  // The Sign-ins page keeps its fuller label, shown escaped.
  assert.equal(browserLabel("Weird/1.0 extra words"), "Weird/1.0");
  assert.equal(browserLabel("python-requests/2.31"), "python-requests");
});

test("sign-in text can't run as a spreadsheet formula (CR-090, CR-071)", () => {
  const row = eventCsvRow(ev(1, "underwriter1", "2026-10-31T11:00:00Z", false, { user_agent: "-2+3", accept_language: "=cmd", edge_region: "@x", geo_source: "\tx" }));
  assert.deepEqual(row.slice(10), ["'@x", "'-2+3", "'=cmd", "'-2+3", "'\tx"]);
  assert.equal(eventCsvRow(ev(2, "u", "2026-10-31T11:00:00Z"))[12], null);
});

test("one network gets a limited number of failed sign-ins (CR-090)", () => {
  const seen: FailureWindows = new Map();
  const t0 = 1_000_000;
  for (let n = 0; n < FAILED_SIGNINS.attempts - 1; n++) noteFailedSignIn(seen, "203.0.113.9", t0);
  assert.equal(signInLimited(seen, "203.0.113.9", t0), false);
  noteFailedSignIn(seen, "203.0.113.9", t0);
  assert.equal(signInLimited(seen, "203.0.113.9", t0), true);
  assert.equal(signInLimited(seen, "203.0.113.10", t0), false, "another address is unaffected");
  assert.equal(signInLimited(seen, "203.0.113.9", t0 + FAILED_SIGNINS.windowMs), false, "the wait ends with the window");
  noteFailedSignIn(seen, "203.0.113.9", t0 + FAILED_SIGNINS.windowMs);
  assert.equal(seen.get("203.0.113.9")?.count, 1, "and the count starts again");

  // Rotating through an IPv6 /64 doesn't get round it; no known address is never limited.
  const six: FailureWindows = new Map();
  for (let n = 0; n < FAILED_SIGNINS.attempts; n++) noteFailedSignIn(six, `2600:1702:82d0:bcf::${n.toString(16)}`, t0);
  assert.equal(signInLimited(six, "2600:1702:82d0:bcf:ffff::1", t0), true);
  assert.equal(signInLimited(six, "2600:1702:82d0:bd0::1", t0), false);
  noteFailedSignIn(six, null, t0);
  assert.equal(signInLimited(six, null, t0), false);
});

test("addressKey: an IPv4 address itself, an IPv6 address's /64 however it is written", () => {
  assert.equal(addressKey("203.0.113.9"), "203.0.113.9");
  assert.equal(addressKey(null), null);
  for (const ip of ["2600:1702:82d0:bcf:b50c:5cac:848d:9d45", "2600:1702:82d0:0bcf::1", "2600:1702:82D0:BCF::", "2600:1702:82d0:bcf:0:0:0:1"]) assert.equal(addressKey(ip), "2600:1702:82d0:bcf::/64", ip);
  assert.equal(addressKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(addressKey("2001:db8:0:1::1"), "2001:db8:0:1::/64");
  assert.equal(addressKey("::1"), "0:0:0:0::/64");
  assert.equal(addressKey("fe80::1%eth0"), "fe80:0:0:0::/64");
});

test("a failed location lookup that won't change is final; a busy or absent service is not (CR-091)", () => {
  for (const s of ["ipwho.is: Invalid IP address", "ipwho.is: Reserved range", "ipwho.is: no result", "ipwho.is: empty result", "ipwho.is HTTP 404"]) assert.equal(geoFailureIsFinal(s), true, s);
  for (const s of ["ipwho.is unreachable (TimeoutError)", "ipwho.is HTTP 429", "ipwho.is HTTP 503", "ipwho.is: unreadable reply", "ipwho.is: You've hit the monthly limit"]) assert.equal(geoFailureIsFinal(s), false, s);
});

test("all-time numbers come from the whole table, not the newest rows a burst of failures fills (CR-115)", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  const flood = Array.from({ length: 5_000 }, (_, n) => ev(n + 2, UNKNOWN_USER, "2026-10-31T11:00:00Z", false, { user_agent: null, geo: null }));
  const firstSignIn = new Date("2026-10-01T09:00:00Z");
  const allTimeUsers = summaryFromTotals([
    { username: UNKNOWN_USER, logins: 0, failures: 5_001, first_seen: null, last_seen: null, ips: null, geos: null, methods: null },
    { username: "underwriter1", logins: 2, failures: 1, first_seen: firstSignIn, last_seen: new Date("2026-10-02T09:00:00Z"),
      ips: [null, "203.0.113.9", "203.0.113.9"], geos: [null, { city: "Austin", region: "Texas", country_code: "US" }, { city: "Austin", region: "Texas", country_code: "US" }], methods: ["api", "signin", "api"] },
  ]);
  const windowUsers = summaryFromTotals([{ username: UNKNOWN_USER, logins: 0, failures: 5_500, first_seen: null, last_seen: null, ips: null, geos: null, methods: null }]);
  const r = buildReport(flood, ["underwriter1", "underwriter2"], { now, eventsTotal: 5_503, earliest: firstSignIn, windowUsers, allTimeUsers });
  assert.equal(r.all_time.logins, 2);
  assert.equal(r.all_time.failures, 5_002);
  assert.deepEqual(r.never_signed_in, ["underwriter2"], "a sign-in older than the newest rows still counts");
  assert.equal(r.all_time.earliest, firstSignIn);
  assert.equal(r.last_24h.failures, 5_500);
  const u1 = r.all_time.users[0];
  assert.deepEqual([u1.username, u1.last_ip, u1.last_place, u1.ips, u1.places, u1.methods], ["underwriter1", null, "", ["203.0.113.9"], ["Austin, Texas, US"], ["api", "signin"]]);
  const md = reportMarkdown(r);
  assert.match(md, /Every attempt \(newest 5000 of 5500; the CSV has them all\)/);
  assert.match(md, /2 successful sign-ins by 1 user; 5002 failed attempts\./);
});
