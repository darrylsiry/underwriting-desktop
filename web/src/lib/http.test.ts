import assert from "node:assert/strict";
import { test } from "node:test";
import { addressedToUs, configuredOrigin, contentDisposition, requestOrigin, safeReturnPath, sameOrigin } from "./http.ts";

test("non-Latin-1 filenames are header-safe (CR-002)", () => {
  const value = contentDisposition('Submission – ACME "final".pdf', "inline");
  assert.equal(value, `inline; filename="Submission _ ACME final.pdf"; filename*=UTF-8''Submission%20%E2%80%93%20ACME%20%22final%22.pdf`);
  assert.doesNotThrow(() => new Response("x", { headers: { "Content-Disposition": value } }));
});

test("return path after a header form stays local (CR-007)", () => {
  assert.equal(safeReturnPath("http://localhost:3000/quotes/abc", "localhost:3000"), "/quotes/abc");
  assert.equal(safeReturnPath("http://localhost:3000//evil.example", "localhost:3000"), "/submissions");
  assert.equal(safeReturnPath("junk", "localhost:3000"), "/submissions");
  assert.equal(safeReturnPath("https://evil.example/x", "localhost:3000"), "/submissions");
  assert.equal(safeReturnPath(null, "localhost:3000"), "/submissions");
});

test("return path keeps the page's query but not its flash message (CR-047)", () => {
  assert.equal(safeReturnPath("http://localhost:3000/audit?submission=abc&correlation=x", "localhost:3000"), "/audit?submission=abc&correlation=x");
  assert.equal(safeReturnPath("http://localhost:3000/accounting?period=ytd&msg=Saved", "localhost:3000"), "/accounting?period=ytd");
  assert.equal(safeReturnPath("http://localhost:3000/search?q=", "localhost:3000"), "/search?q=");
  assert.equal(safeReturnPath("http://localhost:3000//evil.example?x=1", "localhost:3000"), "/submissions");
});

test("cross-site form posts are told apart from the site's own and from API clients (CR-051, CR-065)", () => {
  const h = (o: Record<string, string>) => new Headers({ host: "uwdesk-web.fly.dev", ...o });
  assert.equal(sameOrigin(h({ origin: "https://evil.example" })), false);
  assert.equal(sameOrigin(h({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOrigin(h({ origin: "https://uwdesk-web.fly.dev", "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOrigin(h({ origin: "null" })), false);
  assert.equal(sameOrigin(h({ referer: "https://evil.example/page" })), false);
  assert.equal(sameOrigin(h({ origin: "https://uwdesk-web.fly.dev", "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOrigin(h({ referer: "https://uwdesk-web.fly.dev/accounting?period=ytd" })), true);
  assert.equal(sameOrigin(h({ origin: "http://localhost:3000", host: "localhost:3000" })), true);
  assert.equal(sameOrigin(h({ origin: "https://uwdesk-web.fly.dev", host: "172.19.0.5:3000", "x-forwarded-host": "uwdesk-web.fly.dev" })), true);
  assert.equal(sameOrigin(h({})), true);   // curl, another system: no browser credentials attached
});

test("with PUBLIC_BASE_URL the configured origin wins over forwarded headers (SEC-022, SEC-024)", () => {
  const env = { PUBLIC_BASE_URL: "https://uwdesk-web.fly.dev/" };
  assert.equal(configuredOrigin(env), "https://uwdesk-web.fly.dev");
  assert.equal(configuredOrigin({}), null);
  assert.equal(configuredOrigin({ PUBLIC_BASE_URL: "not a url" }), null);
  assert.equal(configuredOrigin({ PUBLIC_BASE_URL: "javascript:alert(1)" }), null);
  // Absolute links never follow a client's Host or X-Forwarded-Host.
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(requestOrigin(h({ host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" }), env), "https://uwdesk-web.fly.dev");
  assert.equal(requestOrigin(h({ host: "evil.example", "x-forwarded-proto": "http" }), {}), "http://evil.example");   // unset: as before
  assert.equal(requestOrigin(h({ host: "localhost:3100" }), {}), "http://localhost:3100");
  // Rebinding: Origin and Host agree with each other but not with this deployment.
  const rebound = h({ host: "evil.example", origin: "http://evil.example" });
  assert.equal(sameOrigin(rebound, env), false);
  assert.equal(addressedToUs(rebound, env), false);
  assert.equal(sameOrigin(rebound, {}), true);
  assert.equal(addressedToUs(rebound, {}), true);
  assert.equal(sameOrigin(h({ host: "172.19.0.5:3000", "x-forwarded-host": "uwdesk-web.fly.dev", origin: "https://uwdesk-web.fly.dev" }), env), true);
  assert.equal(addressedToUs(h({ host: "172.19.0.5:3000", "x-forwarded-host": "uwdesk-web.fly.dev" }), env), true);
});
