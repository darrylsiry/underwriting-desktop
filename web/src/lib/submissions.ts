import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { audit } from "./audit";
import { customerDb } from "./db";
import { INGESTION_SERVICE_URL } from "./services";
import {
  FIELD_DEFS, REQUIRED_FOR_RATING, fromInput, getPath, isEmpty, sameValue, setPath,
  type Extraction, type SubmissionData, type Value,
} from "./submission";

export type SubmissionRow = {
  id: string;
  reference: string;
  status: "needs_review" | "accepted";
  applicant_name: string;
  data: SubmissionData;
  extraction: Extraction;
  corrected_fields: string[];
  insured_id: string | null;
  received_by: string;
  received_at: Date;
  inbox_folder: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
};

export type DocumentRow = { id: string; filename: string; content_type: string; size: number };

export async function listSubmissions(): Promise<SubmissionRow[]> {
  const { rows } = await customerDb.query<SubmissionRow>("SELECT * FROM submissions ORDER BY received_at DESC");
  return rows;
}

export async function getSubmission(id: string): Promise<SubmissionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await customerDb.query<SubmissionRow>("SELECT * FROM submissions WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listDocuments(submissionId: string): Promise<DocumentRow[]> {
  const { rows } = await customerDb.query<DocumentRow>(
    "SELECT id, filename, content_type, octet_length(content) AS size FROM submission_documents WHERE submission_id = $1 ORDER BY uploaded_at, filename",
    [submissionId],
  );
  return rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getDocument(submissionId: string, documentId: string) {
  // Both ids are path segments; anything that isn't a uuid is a 404, not a Postgres cast error.
  if (!UUID.test(submissionId) || !UUID.test(documentId)) return null;
  const { rows } = await customerDb.query<{ filename: string; content_type: string; content: Buffer }>(
    "SELECT filename, content_type, content FROM submission_documents WHERE submission_id = $1 AND id = $2",
    [submissionId, documentId],
  );
  return rows[0] ?? null;
}

/**
 * Send the files to the ingestion service, then store the submission, its documents, and an audit event.
 * `inboxFolder` is set when the files came from the broker drop folder rather than an upload.
 */
export async function receiveSubmission(files: File[], actor: string, inboxFolder: string | null = null): Promise<string> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch(`${INGESTION_SERVICE_URL}/extract`, {
    method: "POST", body: form, signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Ingestion service returned ${res.status}: ${await res.text()}`);
  const extraction: Extraction = await res.json();

  const client = await customerDb.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; reference: string }>(
      `INSERT INTO submissions (reference, applicant_name, data, extraction, received_by, inbox_folder)
       VALUES ('SUB-' || lpad(nextval('submission_reference_seq')::text, 4, '0'), $1, $2, $3, $4, $5)
       RETURNING id, reference`,
      [extraction.submission.applicant?.name ?? "", extraction.submission, extraction, actor, inboxFolder],
    );
    const { id, reference } = rows[0];
    for (const f of files) {
      await client.query(
        "INSERT INTO submission_documents (submission_id, filename, content_type, content) VALUES ($1, $2, $3, $4)",
        [id, f.name, f.type || "application/octet-stream", Buffer.from(await f.arrayBuffer())],
      );
    }
    await client.query("COMMIT");
    const name = (extraction.submission.applicant?.name as string) || "unnamed applicant";
    await audit({
      actor, action: "submission.received", entityType: "submission", entityId: id,
      summary: `${reference} received for ${name}${inboxFolder ? ` from inbox folder ${inboxFolder}` : ""}: ${files.length} document(s), ${Object.keys(extraction.fields).length} fields extracted`,
      after: { inbox_folder: inboxFolder, documents: extraction.documents, missing_for_rating: extraction.missing_for_rating, claude: extraction.claude },
    });
    return id;
  } catch (err) {
    await client.query("ROLLBACK");
    if ((err as { code?: string }).code === "23505" && inboxFolder) {
      throw new Error(`${inboxFolder} was already picked up from the inbox`);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` on a submission still in intake review, inside a transaction holding its row lock,
 * so concurrent saves and a save racing an accept can't overwrite each other.
 */
async function withReviewLock<T>(id: string, fn: (client: PoolClient, sub: SubmissionRow) => Promise<T>): Promise<T> {
  const client = await customerDb.connect();
  try {
    await client.query("BEGIN");
    const sub = (await client.query<SubmissionRow>("SELECT * FROM submissions WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!sub) throw new Error("Submission not found");
    if (sub.status !== "needs_review") throw new Error(`${sub.reference} is already accepted`);
    const result = await fn(client, sub);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Fingerprint of the data a review form was rendered from (jsonb comes back in a stable order). */
export function dataFingerprint(data: SubmissionData): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
}

/**
 * Apply the underwriter's edits; each changed field is audited with before/after. Returns how many changed.
 * `fingerprint` is the data the form showed: if someone saved since, refuse rather than revert their edits.
 */
export async function saveReview(id: string, inputs: Record<string, string>, actor: string, fingerprint?: string): Promise<number> {
  const { reference, changes } = await withReviewLock(id, async (client, sub) => {
    if (fingerprint && fingerprint !== dataFingerprint(sub.data)) {
      throw new Error(`${sub.reference} was changed by someone else since you opened it. Reload to see their edits, then save again.`);
    }
    const data = structuredClone(sub.data);
    const changes: { path: string; before: Value; after: Value }[] = [];
    for (const def of FIELD_DEFS) {
      if (!(def.path in inputs)) continue;
      const after = fromInput(def, inputs[def.path]);
      const before = getPath(data, def.path);
      if (!sameValue(before, after)) {
        setPath(data, def.path, after);
        changes.push({ path: def.path, before, after });
      }
    }
    if (changes.length) {
      const corrected = [...new Set([...sub.corrected_fields, ...changes.map((c) => c.path)])];
      await client.query(
        `UPDATE submissions SET data = $2, corrected_fields = $3, applicant_name = $4
         WHERE id = $1 AND status = 'needs_review'`,
        [id, data, corrected, (data.applicant?.name as string) ?? ""],
      );
    }
    return { reference: sub.reference, changes };
  });

  if (changes.length) {
    const correlationId = crypto.randomUUID();
    await audit(...changes.map((c) => ({
      actor, action: "submission.field_corrected", entityType: "submission" as const, entityId: id,
      summary: `${reference}: ${c.path} corrected`, before: { [c.path]: c.before }, after: { [c.path]: c.after },
      correlationId,
    })));
  }
  return changes.length;
}

export function missingForRating(data: SubmissionData): string[] {
  return REQUIRED_FOR_RATING.filter((p) => isEmpty(getPath(data, p)));
}

/** Accept the intake: link (or create) the insured and lock the extracted data for underwriting. */
export async function acceptSubmission(id: string, actor: string): Promise<void> {
  const r = await withReviewLock(id, async (client, sub) => {
    const missing = missingForRating(sub.data);
    if (missing.length) throw new Error(`Fill in before accepting: ${missing.join(", ")}`);
    const a = sub.data.applicant;
    const name = String(a.name ?? "").trim();
    if (!name) throw new Error("Fill in the named insured before accepting");
    const fein = String(a.fein ?? "").trim();
    const state = String(a.state ?? "");

    const existing = fein
      ? (await client.query<{ id: string }>("SELECT id FROM insureds WHERE fein = $1", [fein])).rows[0]
      : undefined;
    const insuredId = existing?.id ?? (await client.query<{ id: string }>(
      "INSERT INTO insureds (name, fein, state) VALUES ($1, $2, $3) RETURNING id", [name, fein, state],
    )).rows[0].id;
    await client.query(
      `UPDATE submissions SET status = 'accepted', insured_id = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $1 AND status = 'needs_review'`,
      [id, insuredId, actor],
    );
    return { sub, insuredId, created: !existing, name, fein, state };
  });

  const correlationId = crypto.randomUUID();
  await audit(
    ...(r.created ? [{
      actor, action: "insured.created", entityType: "insured" as const, entityId: r.insuredId,
      summary: `Insured ${r.name} created from ${r.sub.reference}`, after: { name: r.name, fein: r.fein, state: r.state }, correlationId,
    }] : []),
    {
      actor, action: "submission.accepted", entityType: "submission", entityId: id,
      summary: `${r.sub.reference} intake accepted (${r.sub.corrected_fields.length} field(s) corrected)`,
      after: { insured_id: r.insuredId, corrected_fields: r.sub.corrected_fields }, correlationId,
    },
  );
}
