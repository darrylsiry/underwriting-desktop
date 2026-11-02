import assert from "node:assert/strict";
import { test } from "node:test";
import { isUuid, paddedSeq } from "./text.ts";

test("only a well-formed uuid passes (CR-031)", () => {
  assert.equal(isUuid("3f2b1c9e-7a10-4c55-9a7e-0123456789ab"), true);
  assert.equal(isUuid("3F2B1C9E-7A10-4C55-9A7E-0123456789AB"), true);
  assert.equal(isUuid("a".repeat(36)), false);
  assert.equal(isUuid("-".repeat(36)), false);
  assert.equal(isUuid("3f2b1c9e7a104c559a7e0123456789ab----"), false);
  assert.equal(isUuid(""), false);
});

test("a padded sequence widens past its pad rather than truncating (CR-033)", () => {
  const sql = paddedSeq("submission_reference_seq", 4);
  assert.match(sql, /nextval\('submission_reference_seq'\)/);
  assert.match(sql, /GREATEST\(4, length\(n::text\)\)/);
});
