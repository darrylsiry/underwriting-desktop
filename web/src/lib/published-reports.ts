// The review agents' reports as last published to this deployment (step 30), in the policy database.
// agent-activity.ts reads them; POST /api/reports/publish replaces them.

import { policyDb } from "./db.ts";
import { LEDGER_FILE, ledgerTime, type PublishedFile } from "./report-publish.ts";

const PUBLISH_LOCK = 8_230_030;

export type PublishedSet = { files: Map<string, { text: string; mtime: Date }>; publishedAt: Date };

/**
 * Replace the set, whole or not at all. A set older than the one stored is refused ("stale"): a
 * forgotten copy elsewhere can't take the page backwards.
 */
export async function storePublished(files: PublishedFile[]): Promise<"stored" | "unchanged" | "stale"> {
  const client = await policyDb.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [PUBLISH_LOCK]);
    const { rows } = await client.query<{ name: string; body: string }>("SELECT name, body FROM published_reports");
    const stored = new Map(rows.map((r) => [r.name, r.body]));
    const incoming = files.find((f) => f.name === LEDGER_FILE)?.text;
    let outcome: "stored" | "unchanged" | "stale" = "stored";
    if (ledgerTime(incoming) < ledgerTime(stored.get(LEDGER_FILE))) outcome = "stale";
    else if (stored.size === files.length && files.every((f) => stored.get(f.name) === f.text)) outcome = "unchanged";
    else {
      await client.query("DELETE FROM published_reports");
      await client.query(
        "INSERT INTO published_reports (name, body, written_at) SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[])",
        [files.map((f) => f.name), files.map((f) => f.text), files.map((f) => f.written_at)],
      );
    }
    await client.query("COMMIT");
    return outcome;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The stored set, or null when nothing has been published. */
export async function loadPublished(): Promise<PublishedSet | null> {
  const { rows } = await policyDb.query<{ name: string; body: string; written_at: Date; published_at: Date }>(
    "SELECT name, body, written_at, published_at FROM published_reports",
  );
  if (!rows.length) return null;
  return { files: new Map(rows.map((r) => [r.name, { text: r.body, mtime: r.written_at }])), publishedAt: rows[0].published_at };
}
