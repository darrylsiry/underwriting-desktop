// CR-038: instances starting together must not race on CREATE TABLE or seed the same history twice.
// A Postgres advisory lock serializes them. It's held by a transaction on its own connection, not by
// a session: a transaction-pooled connection (PgBouncer) can hand a session lock to someone else, but
// a transaction stays on its one server connection. The work itself runs on other connections.
// Type-only imports, so node:test can load this.
import type { PoolClient } from "pg";

export const MIGRATION_LOCK = 72_700_101;
export const SEED_HISTORY_LOCK = 72_700_102;

type LockClient = Pick<PoolClient, "query" | "release" | "on" | "off">;
type LockPool = { connect(): Promise<LockClient> };

async function holding<T>(pool: LockPool, acquire: string, key: number, fn: () => Promise<T>): Promise<{ value: T } | null> {
  const client = await pool.connect();
  // A connection dropped while we wait on `fn` emits 'error'; unhandled, that would stop the process.
  let broken = false;
  const onError = () => { broken = true; };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ locked: boolean | null | "" }>(`${acquire} AS locked`, [key]);
    if (rows[0]?.locked === false) return null;
    return { value: await fn() };
  } finally {
    await client.query("ROLLBACK").catch(() => { broken = true; });   // nothing was written here; ending the transaction frees the lock
    client.off("error", onError);
    client.release(broken);
  }
}

/** Run `fn` holding the lock, waiting for whoever has it now. */
export async function withAdvisoryLock<T>(pool: LockPool, key: number, fn: () => Promise<T>): Promise<T> {
  return (await holding(pool, "SELECT pg_advisory_xact_lock($1)", key, fn))!.value;
}

/** Run `fn` if the lock is free. Returns null, without running it, when someone else holds it. */
export async function tryAdvisoryLock<T>(pool: LockPool, key: number, fn: () => Promise<T>): Promise<T | null> {
  const held = await holding(pool, "SELECT pg_try_advisory_xact_lock($1)", key, fn);
  return held ? held.value : null;
}
