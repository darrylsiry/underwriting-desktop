import assert from "node:assert/strict";
import { test } from "node:test";
import { basicAuthOk } from "./basic-auth.ts";

const header = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

test("basic auth accepts only the exact credentials", () => {
  assert.equal(basicAuthOk(header("uw:s3cret:with:colons"), "uw", "s3cret:with:colons"), true);
  assert.equal(basicAuthOk(header("uw:wrong"), "uw", "s3cret"), false);
  assert.equal(basicAuthOk(header("other:s3cret"), "uw", "s3cret"), false);
  assert.equal(basicAuthOk(header("no-colon"), "uw", "s3cret"), false);
  assert.equal(basicAuthOk("Bearer abc", "uw", "s3cret"), false);
  assert.equal(basicAuthOk(null, "uw", "s3cret"), false);
});
