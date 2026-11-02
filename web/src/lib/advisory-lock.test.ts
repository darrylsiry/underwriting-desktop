import assert from "node:assert/strict";
import { test } from "node:test";
import { tryAdvisoryLock, withAdvisoryLock } from "./advisory-lock.ts";

function fakePool(locked: boolean | null = null, opts: { failEnd?: boolean } = {}) {
  const log: string[] = [];
  const listeners = new Set<unknown>();
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      log.push(params ? `${sql} [${params}]` : sql);
      if (opts.failEnd && sql === "ROLLBACK") throw new Error("connection gone");
      return { rows: [{ locked }] };
    },
    on: (_: string, f: unknown) => { listeners.add(f); return client; },
    off: (_: string, f: unknown) => { listeners.delete(f); return client; },
    release: (destroy?: boolean) => { log.push(`release ${!!destroy}`); },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { pool: { connect: async () => client as any }, log, listeners };
}

test("the lock is held for as long as the work runs, on its own transaction, then freed", async () => {
  const { pool, log, listeners } = fakePool();
  const value = await withAdvisoryLock(pool, 7, async () => {
    log.push("work");
    assert.equal(listeners.size, 1, "a dropped connection can't crash the process meanwhile");
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(log, ["BEGIN", "SELECT pg_advisory_xact_lock($1) AS locked [7]", "work", "ROLLBACK", "release false"]);
  assert.equal(listeners.size, 0);
});

test("work that fails still frees the lock and surfaces its error", async () => {
  const { pool, log } = fakePool();
  await assert.rejects(withAdvisoryLock(pool, 7, async () => { throw new Error("bad migration"); }), /bad migration/);
  assert.deepEqual(log.slice(-2), ["ROLLBACK", "release false"]);
});

test("tryAdvisoryLock skips the work when someone else holds the lock", async () => {
  const { pool, log } = fakePool(false);
  let ran = false;
  assert.equal(await tryAdvisoryLock(pool, 9, async () => { ran = true; return 1; }), null);
  assert.equal(ran, false);
  assert.deepEqual(log, ["BEGIN", "SELECT pg_try_advisory_xact_lock($1) AS locked [9]", "ROLLBACK", "release false"]);
});

test("tryAdvisoryLock runs the work when the lock is free", async () => {
  const { pool } = fakePool(true);
  assert.equal(await tryAdvisoryLock(pool, 9, async () => "seeded"), "seeded");
});

test("a connection lost before the end is thrown away, not returned to the pool", async () => {
  const { pool, log } = fakePool(true, { failEnd: true });
  assert.equal(await tryAdvisoryLock(pool, 9, async () => "seeded"), "seeded");
  assert.equal(log.at(-1), "release true");
});
