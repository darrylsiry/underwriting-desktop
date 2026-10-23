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

/** Send the files to the ingestion service, then store the submission, its documents, and an audit event. */
export async function receiveSubmission(files: File[], actor: string): Promise<string> {
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
      `INSERT INTO submissions (reference, applicant_name, data, extraction, received_by)
       VALUES ('SUB-' || lpad(nextval('submission_reference_seq')::text, 4, '0'), $1, $2, $3, $4)
       RETURNING id, reference`,
      [extraction.submission.applicant?.name ?? "", extraction.submission, extraction, actor],
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
      summary: `${reference} received for ${name}: ${files.length} document(s), ${Object.keys(extraction.fields).length} fields extracted`,
      after: { documents: extraction.documents, missing_for_rating: extraction.missing_for_rating, claude: extraction.claude },
    });
    return id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Apply the underwriter's edits; each changed field is audited with before/after. Returns how many changed. */
export async function saveReview(id: string, inputs: Record<string, string>, actor: string): Promise<number> {
  const sub = await getSubmission(id);
  if (!sub) throw new Error("Submission not found");
  if (sub.status !== "needs_review") throw new Error(`${sub.reference} is already accepted`);

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
  if (!changes.length) return 0;

  const corrected = [...new Set([...sub.corrected_fields, ...changes.map((c) => c.path)])];
  await customerDb.query(
    "UPDATE submissions SET data = $2, corrected_fields = $3, applicant_name = $4 WHERE id = $1",
    [id, data, corrected, (data.applicant?.name as string) ?? ""],
  );
  const correlationId = crypto.randomUUID();
  await audit(...changes.map((c) => ({
    actor, action: "submission.field_corrected", entityType: "submission" as const, entityId: id,
    summary: `${sub.reference}: ${c.path} corrected`, before: { [c.path]: c.before }, after: { [c.path]: c.after },
    correlationId,
  })));
  return changes.length;
}

export function missingForRating(data: SubmissionData): string[] {
  return REQUIRED_FOR_RATING.filter((p) => isEmpty(getPath(data, p)));
}

/** Accept the intake: link (or create) the insured and lock the extracted data for underwriting. */
export async function acceptSubmission(id: string, actor: string): Promise<void> {
  const sub = await getSubmission(id);
  if (!sub) throw new Error("Submission not found");
  if (sub.status !== "needs_review") throw new Error(`${sub.reference} is already accepted`);
  const missing = missingForRating(sub.data);
  if (missing.length) throw new Error(`Fill in before accepting: ${missing.join(", ")}`);

  const a = sub.data.applicant;
  const name = String(a.name ?? "").trim();
  if (!name) throw new Error("Fill in the named insured before accepting");
  const fein = String(a.fein ?? "").trim();
  const client = await customerDb.connect();
  let insuredId: string;
  try {
    await client.query("BEGIN");
    const existing = fein
      ? (await client.query<{ id: string }>("SELECT id FROM insureds WHERE fein = $1", [fein])).rows[0]
      : undefined;
    insuredId = existing?.id ?? (await client.query<{ id: string }>(
      "INSERT INTO insureds (name, fein, state) VALUES ($1, $2, $3) RETURNING id",
      [name, fein, String(a.state ?? "")],
    )).rows[0].id;
    await client.query(
      "UPDATE submissions SET status = 'accepted', insured_id = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1",
      [id, insuredId, actor],
    );
    await client.query("COMMIT");
    const correlationId = crypto.randomUUID();
    await audit(
      ...(existing ? [] : [{
        actor, action: "insured.created", entityType: "insured" as const, entityId: insuredId,
        summary: `Insured ${name} created from ${sub.reference}`, after: { name, fein, state: a.state }, correlationId,
      }]),
      {
        actor, action: "submission.accepted", entityType: "submission", entityId: id,
        summary: `${sub.reference} intake accepted (${sub.corrected_fields.length} field(s) corrected)`,
        after: { insured_id: insuredId, corrected_fields: sub.corrected_fields }, correlationId,
      },
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
