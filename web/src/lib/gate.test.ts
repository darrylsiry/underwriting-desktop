import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AUTH_USER_HEADER, loadUsers } from "./basic-auth.ts";
import { basicUser, forwardedHeaders, PUBLIC_PATH, requestUser } from "./gate.ts";
import { signSession } from "./session.ts";

const KEY = "test-signing-key";
const users = loadUsers({ BASIC_AUTH_USERS: "underwriter1:one,underwriter2:two" });
const cookie = (name: string) => signSession(name, KEY, new Date(Date.now() + 60_000));
const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

test("the public paths are exact: a look-alike route is gated (CR-099)", () => {
  for (const p of ["/signin", "/signin/", "/signout", "/request-access", "/request-access/", "/api/live", "/api/reports/publish"]) assert.ok(PUBLIC_PATH.test(p), p);
  for (const p of ["/", "/signin-help", "/signinx", "/signout2", "/request-access-admin", "/api/live2", "/api/livestock", "/api/gl", "/api/reports/logins", "/api/reports/publish2", "/x/signin", "/SIGNIN"]) assert.ok(!PUBLIC_PATH.test(p), p);
});

test("the middleware runs on every path except static files, so it can strip the identity header there (CR-099)", () => {
  const matcher = /matcher:\s*"([^"]+)"/.exec(readFileSync("src/middleware.ts", "utf8"))?.[1] ?? "";
  assert.ok(matcher);
  for (const word of ["signin", "signout", "request-access", "api/live"]) assert.ok(!matcher.includes(word), `the matcher must not skip ${word}`);
});

test("a client can't name itself: only a verified user reaches the app (CR-099)", () => {
  const spoofed = new Headers({ [AUTH_USER_HEADER]: "underwriter1", accept: "text/html" });
  assert.equal(forwardedHeaders(spoofed, null).get(AUTH_USER_HEADER), null);
  assert.equal(forwardedHeaders(spoofed, null).get("accept"), "text/html");
  assert.equal(forwardedHeaders(spoofed, "underwriter2").get(AUTH_USER_HEADER), "underwriter2");
  assert.equal(spoofed.get(AUTH_USER_HEADER), "underwriter1", "the original is left alone");
});

test("a session counts only while its login exists (CR-083)", () => {
  assert.equal(requestUser(cookie("underwriter1"), null, users, KEY), "underwriter1");
  assert.equal(requestUser(cookie("removed"), null, users, KEY), null);
  assert.equal(requestUser(cookie("removed"), basic("underwriter2:two"), users, KEY), "underwriter2", "Basic still works beside a stale cookie");
  assert.equal(requestUser(undefined, basic("underwriter1:one"), users, KEY), "underwriter1");
  assert.equal(requestUser(undefined, basic("underwriter1:wrong"), users, KEY), null);
  assert.equal(requestUser("tampered.value", null, users, KEY), null);
  assert.equal(requestUser(cookie("underwriter1"), null, users, "another-key"), null);
});

test("basicUser names HTTP Basic logins only: a live session is not a new login (CR-093)", () => {
  const users = loadUsers({ BASIC_AUTH_USERS: "ann:pw1,bob:pw2" });
  const key = "test-key";
  const basic = `Basic ${Buffer.from("bob:pw2").toString("base64")}`;
  const cookie = signSession("ann", key, new Date(Date.now() + 60_000));
  assert.equal(basicUser(undefined, basic, users, key), "bob");
  assert.equal(basicUser(cookie, basic, users, key), null, "the session is what proved it");
  assert.equal(basicUser(undefined, null, users, key), null);
  assert.equal(requestUser(cookie, null, users, key), "ann");
});
