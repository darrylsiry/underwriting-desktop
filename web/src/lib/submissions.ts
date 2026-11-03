import type { Decline } from "./file-closure";
import { isUuid, paddedSeq, plural } from "./text.ts";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { audit } from "./audit";
import { customerDb } from "./db";
import type { ExpiringPolicy } from "./renewal-compare";
import { INGESTION_SERVICE_URL } from "./services";
import { ServiceError, describeServiceError, errorDetailOf } from "./service-errors";
import {
  FIELD_DEFS, fromInput, getPath, missingForRating, normalizeFein, sameValue, setPath,
  type Extraction, type SubmissionData, type Value, fieldLabel } from "./submission";

export { missingForRating };

export type SubmissionRow = {
  id: string;
  reference: string;
  status: "needs_review" | "accepted" | "declined";
  decline?: Decline | null;
  applicant_name: string;
  data: SubmissionData;
  extraction: Extraction;
  corrected_fields: string[];
  insured_id: string | null;
  received_by: string;
  received_at: Date;
  inbox_folder: string | null;
  kind: "new" | "renewal";
  renewal_of: ExpiringPolicy | null;   // the expiring policy, for a renewal
  reviewed_by: string | null;
  reviewed_at: Date | null;
};

export type DocumentRow = { id: string; filename: string; content_type: string; size: number };

/** Ids of the submissions an underwriter picked up (received_by): what the desk counts as theirs. */
export async function submissionIdsReceivedBy(user: string): Promise<string[]> {
  const { rows } = await customerDb.query<{ id: string }>("SELECT id FROM submissions WHERE received_by = $1", [user]);
  return rows.map((r) => r.id);
}

export async function listSubmissions(): Promise<SubmissionRow[]> {
  const { rows } = await customerDb.query<SubmissionRow>("SELECT * FROM submissions ORDER BY received_at DESC");
  return rows;
}

export async function getSubmission(id: string): Promise<SubmissionRow | null> {
  if (!isUuid(id)) return null;
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

export async function getDocument(submissionId: string, documentId: string) {
  // Both ids are path segments; anything that isn't a uuid is a 404, not a Postgres cast error.
  if (!isUuid(submissionId) || !isUuid(documentId)) return null;
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
  // UX-008: the underwriter needs to know whether anything was saved and what to do, not the socket error or the raw body.
  let res: Response;
  try {
    res = await fetch(`${INGESTION_SERVICE_URL}/extract`, {
      method: "POST", body: filesForm(files), signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    throw new Error(describeServiceError(err, "document reader"));
  }
  if (!res.ok) throw new Error(describeServiceError(new ServiceError(res.status, errorDetailOf(await res.text())), "document reader"));
  return (await storeSubmission(files, await res.json(), actor, inboxFolder)).id;
}

export function filesForm(files: File[]): FormData {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  return form;
}

/**
 * Store an extraction with its documents and audit it. Used by uploads and the streaming inbox route.
 * `at` back-dates the receipt (seeded history); it defaults to now.
 */
export async function storeSubmission(
  files: File[], extraction: Extraction, actor: string, inboxFolder: string | null, at: Date | null = null,
): Promise<{ id: string; reference: string }> {
  const client = await customerDb.connect();
  let stored: { id: string; reference: string };
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; reference: string }>(
      `INSERT INTO submissions (reference, applicant_name, data, extraction, received_by, inbox_folder, received_at)
       VALUES ('SUB-' || ${paddedSeq("submission_reference_seq", 4)}, $1, $2, $3, $4, $5, coalesce($6, now()))
       RETURNING id, reference`,
      [extraction.submission.applicant?.name ?? "", extraction.submission, extraction, actor, inboxFolder, at],
    );
    stored = rows[0];
    for (const f of files) {
      await client.query(
        "INSERT INTO submission_documents (submission_id, filename, content_type, content) VALUES ($1, $2, $3, $4)",
        [stored.id, f.name, f.type || "application/octet-stream", Buffer.from(await f.arrayBuffer())],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if ((err as { code?: string }).code === "23505" && inboxFolder) {
      throw new Error(`${inboxFolder} was already picked up from the inbox`);
    }
    throw err;
  } finally {
    client.release();
  }

  // The submission is safely in. The audit trail is in the other database, so a failure there is logged, not
  // reported as a failed upload: that would invite a retry and a second reference for the same file (CR-049).
  const name = (extraction.submission.applicant?.name as string) || "unnamed applicant";
  try {
    await audit({
      actor, action: "submission.received", entityType: "submission", entityId: stored.id,
      summary: `${stored.reference} received for ${name}${inboxFolder ? ` from inbox folder ${inboxFolder}` : ""}: ${plural(files.length, "document")}, ${plural(Object.keys(extraction.fields).length, "field")} extracted`,
      after: { inbox_folder: inboxFolder, documents: extraction.documents, missing_for_rating: extraction.missing_for_rating, claude: extraction.claude },
      occurredAt: at ?? undefined,
    });
  } catch (err) {
    console.error(`[audit] submission.received not recorded for ${stored.reference}:`, err);
  }
  return stored;
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
  return withReviewLock(id, async (client, sub) => {
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
      // Under the lock and before COMMIT, so a failure leaves no unaudited correction and a retry isn't told someone else changed it (CR-144).
      const correlationId = crypto.randomUUID();
      await audit(...changes.map((c) => ({
        actor, action: "submission.field_corrected", entityType: "submission" as const, entityId: id,
        summary: `${sub.reference}: ${fieldLabel(c.path)} corrected`, before: { [c.path]: c.before }, after: { [c.path]: c.after },
        correlationId,
      })));
    }
    return changes.length;
  });
}

/** Accept the intake: link (or create) the insured and lock the extracted data for underwriting. `at` back-dates it (seeded history). */
export async function acceptSubmission(id: string, actor: string, at: Date | null = null): Promise<void> {
  await withReviewLock(id, async (client, sub) => {
    const missing = missingForRating(sub.data);
    if (missing.length) throw new Error(`Fill in before accepting: ${missing.map(fieldLabel).join(", ")}`);
    const a = sub.data.applicant;
    const name = String(a.name ?? "").trim();
    if (!name) throw new Error("Fill in the named insured before accepting");
    const fein = normalizeFein(String(a.fein ?? ""));
    const state = String(a.state ?? "");

    // One statement, so two accepts of one FEIN can't both insert: the loser waits, inserts nothing, and finds the winner's row (CR-036).
    // A blank FEIN isn't covered by the unique index, so it always makes a new insured.
    const made = (await client.query<{ id: string }>(
      `INSERT INTO insureds (name, fein, state, created_at) VALUES ($1, $2, $3, coalesce($4, now()))
       ON CONFLICT (fein) WHERE fein <> '' DO NOTHING RETURNING id`, [name, fein, state, at],
    )).rows[0];
    const insuredId = made?.id ?? (await client.query<{ id: string }>("SELECT id FROM insureds WHERE fein = $1", [fein])).rows[0].id;
    await client.query(
      `UPDATE submissions SET status = 'accepted', insured_id = $2, reviewed_by = $3, reviewed_at = coalesce($4, now())
       WHERE id = $1 AND status = 'needs_review'`,
      [id, insuredId, actor, at],
    );

    // Under the lock and before COMMIT, so a failure leaves no unaudited acceptance (CR-144).
    const correlationId = crypto.randomUUID();
    await audit(
      ...(made ? [{
        actor, action: "insured.created", entityType: "insured" as const, entityId: insuredId,
        summary: `Insured ${name} created from ${sub.reference}`, after: { name, fein, state }, correlationId,
        occurredAt: at ?? undefined,
      }] : []),
      {
        actor, action: "submission.accepted", entityType: "submission", entityId: id,
        summary: `${sub.reference} intake accepted (${plural(sub.corrected_fields.length, "field")} corrected)`,
        after: { insured_id: insuredId, corrected_fields: sub.corrected_fields }, correlationId, occurredAt: at ?? undefined,
      },
    );
  });
}
