import assert from "node:assert/strict";
import { test } from "node:test";
import { listMeta } from "./assistant-lists.ts";

test("a cut list reports what it left out (CR-149)", () => {
  const m = listMeta(50, 60, "policies");
  assert.equal(m.count, 50);
  assert.equal(m.total_matching, 60);
  assert.equal(m.truncated, true);
  assert.match(m.note!, /50 of 60 policies/);
  assert.match(m.note!, /covers all 60/);
});

test("a whole list says nothing extra (CR-149)", () => {
  assert.deepEqual(listMeta(12, 12, "quote versions"), { count: 12, total_matching: 12 });
  assert.deepEqual(listMeta(0, 0, "submissions"), { count: 0, total_matching: 0 });
});
