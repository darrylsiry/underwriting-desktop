import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionKey, signSession, verifySession } from "./session.ts";

test("a session round-trips, and is refused when tampered with, signed with another key, or expired", () => {
  const key = sessionKey({ BASIC_AUTH_USERS: "underwriter1:x,underwriter2:y" });
  const exp = new Date("2026-11-06T00:00:00Z");
  const token = signSession("underwriter2", key, exp);
  assert.equal(verifySession(token, key, new Date("2026-10-30T00:00:00Z")), "underwriter2");
  assert.equal(verifySession(token, key, new Date("2026-11-07T00:00:00Z")), null, "expired");
  assert.equal(verifySession(token, sessionKey({ BASIC_AUTH_USERS: "underwriter1:changed" }), new Date("2026-10-30")), null, "other key");
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ u: "underwriter1", exp: exp.getTime() })).toString("base64url");
  assert.equal(verifySession(`${forged}.${sig}`, key, new Date("2026-10-30")), null, "payload swapped");
  assert.equal(verifySession(`${payload}.`, key), null);
  assert.equal(verifySession(undefined, key), null);
  assert.equal(sessionKey({ SESSION_SECRET: "s3cret" }), "s3cret");
});
