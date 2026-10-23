import fs from "node:fs";
import path from "node:path";
import { pools, type DbName } from "./db";

/** Apply migrations/<db>/*.sql files not yet recorded, in filename order. */
export async function migrate(): Promise<void> {
  for (const name of Object.keys(pools) as DbName[]) {
    const pool = pools[name];
    const dir = path.join(process.cwd(), "migrations", name);
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
}
