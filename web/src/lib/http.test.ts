import assert from "node:assert/strict";
import { test } from "node:test";
import { contentDisposition, safeReturnPath, sameOrigin } from "./http.ts";

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
