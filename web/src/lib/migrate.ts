import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { MIGRATION_LOCK, withAdvisoryLock } from "./advisory-lock.ts";
import { pools, type DbName } from "./db";

// CR-096: the restricted runtime roles in db/roles.sql can't change the schema, so migrations can
// connect as the owner instead. Unset, they run on the app's own connection, as they always have.
const OWNER_URLS: Record<DbName, string | undefined> = {
  customer: process.env.CUSTOMER_MIGRATION_DATABASE_URL,
  policy: process.env.POLICY_MIGRATION_DATABASE_URL,
};

async function applyMigrations(pool: Pool, dir: string): Promise<void> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Apply migrations/<db>/*.sql files not yet recorded, in filename order, one starting instance at a time (CR-038). */
export async function migrate(): Promise<void> {
  for (const name of Object.keys(pools) as DbName[]) {
    const owner = OWNER_URLS[name];
    const pool = owner ? new Pool({ connectionString: owner, max: 2 }) : pools[name];   // two: the lock holds one while a migration runs on the other
    try {
      await withAdvisoryLock(pool, MIGRATION_LOCK, () => applyMigrations(pool, path.join(process.cwd(), "migrations", name)));
    } finally {
      if (owner) await pool.end();
    }
  }
}
