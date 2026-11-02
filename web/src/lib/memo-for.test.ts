import assert from "node:assert/strict";
import { test } from "node:test";
import { memoFor } from "./memo-for.ts";

test("one call per window, shared by those asking at once, including an empty answer (CR-085)", async () => {
  let clock = 1_000;
  let calls = 0;
  const get = memoFor(30_000, async () => { calls += 1; return null; }, () => clock);

  assert.deepEqual(await Promise.all([get(), get(), get()]), [null, null, null]);
  assert.equal(calls, 1);

  clock += 29_999;
  await get();
  assert.equal(calls, 1);

  clock += 1;
  await get();
  assert.equal(calls, 2);
});
