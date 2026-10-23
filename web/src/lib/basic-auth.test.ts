import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticate, basicAuthOk, loadUsers } from "./basic-auth.ts";

const header = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

test("basic auth accepts only the exact credentials", () => {
  assert.equal(basicAuthOk(header("uw:s3cret:with:colons"), "uw", "s3cret:with:colons"), true);
  assert.equal(basicAuthOk(header("uw:wrong"), "uw", "s3cret"), false);
  assert.equal(basicAuthOk(header("other:s3cret"), "uw", "s3cret"), false);
  assert.equal(basicAuthOk(header("no-colon"), "uw", "s3cret"), false);
  assert.equal(basicAuthOk("Bearer abc", "uw", "s3cret"), false);
  assert.equal(basicAuthOk(null, "uw", "s3cret"), false);
});

test("several users each sign in with their own password", () => {
  const users = loadUsers({ BASIC_AUTH_USERS: "underwriter1:pw-one, underwriter2:pw:two ,broken,:nouser,nopass:" });
  assert.deepEqual([...users.keys()], ["underwriter1", "underwriter2"]);
  assert.equal(authenticate(header("underwriter1:pw-one"), users), "underwriter1");
  assert.equal(authenticate(header("underwriter2:pw:two"), users), "underwriter2");
  assert.equal(authenticate(header("underwriter2:pw-one"), users), null);
  assert.equal(authenticate(header("underwriter3:pw-one"), users), null);
  assert.equal(authenticate(null, users), null);
});

test("the single-user secrets still work, and no secrets means the gate is off", () => {
  assert.deepEqual([...loadUsers({ BASIC_AUTH_USER: "uw", BASIC_AUTH_PASSWORD: "s" })], [["uw", "s"]]);
  assert.deepEqual([...loadUsers({ BASIC_AUTH_PASSWORD: "s" })], [["underwriter1", "s"]]);
  assert.equal(loadUsers({}).size, 0);
  assert.equal(loadUsers({ BASIC_AUTH_USERS: "a:1", BASIC_AUTH_USER: "b", BASIC_AUTH_PASSWORD: "2" }).has("b"), false);
});
