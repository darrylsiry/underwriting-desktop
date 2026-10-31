import assert from "node:assert/strict";
import { test } from "node:test";
import { browserLabel, buildReport, clientInfo, isPublicIp, place, reportMarkdown, summarize, type LoginEvent } from "./login-meta.ts";

const H = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

test("clientInfo prefers Fly-Client-IP, then the first X-Forwarded-For hop, and records nothing locally", () => {
  assert.equal(clientInfo(H({ "fly-client-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 10.0.0.1" })).ip, "203.0.113.9");
  assert.equal(clientInfo(H({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" })).ip, "198.51.100.1");
  assert.equal(clientInfo(H({ "x-forwarded-for": "::ffff:198.51.100.7" })).ip, "198.51.100.7");
  const local = clientInfo(H({ "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9", "fly-region": "iad" }));
  assert.deepEqual(local, { ip: null, user_agent: "Mozilla/5.0", accept_language: "en-US,en;q=0.9", edge_region: "iad" });
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
