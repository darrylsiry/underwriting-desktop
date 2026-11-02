import { isUuid, paddedSeq } from "./text.ts";
import { audit } from "./audit";
import { policyDb } from "./db";
import { renderQuotePdf } from "./quote-pdf";
import { changeSummary, compareRenewal, type Comparison } from "./renewal-compare";
import { renderRenewalMemoPdf } from "./renewal-memo-pdf";
import { QUOTE_VALID_DAYS, addDays, formsFor, parseSubjectivities, producerFields, producerLines, quoteLimits, quotePeriod, type ProducerFields } from "./quote-terms";
import { rateOn } from "./rating-api";
import type { SubmissionRow } from "./submissions";
import type { RatingInputs, ScheduleItem } from "./worksheet";
import { activeRateVersion, getWorksheet, money, readiness, type Rating } from "./worksheets";

export type QuoteRow = {
  id: string; quote_number: string; version: number; status: "issued" | "superseded" | "bound";
  submission_id: string; submission_ref: string; insured_id: string | null; insured_name: string;   // UX-013: lists link the insured
  effective_date: string; expiration_date: string; valid_until: string;
  rating_id: string; rate_version: string; premium: string; policy_fee: string; surplus_lines_tax: string; total: string;
  subjectivities: string[]; issued_by: string; issued_at: Date;
  has_memo: boolean;   // a renewal quote carries a memo to the insured
};

// Dates come back as JS Dates by default; keep them as YYYY-MM-DD strings.
const COLUMNS = `id, quote_number, version, status, submission_id, submission_ref, insured_id, insured_name,
  effective_date::text, expiration_date::text, valid_until::text, rating_id, rate_version,
  premium, policy_fee, surplus_lines_tax, total, subjectivities, issued_by, issued_at, (memo_pdf IS NOT NULL) AS has_memo`;

/** Where issuing a revised quote lands the underwriter: the Quotes page with that version called out. */
export const issuedQuoteHref = (quoteId: string) => `/quotes?highlight=${quoteId}#quote-${quoteId}`;

export async function quotesForSubmission(submissionId: string): Promise<QuoteRow[]> {
  const { rows } = await policyDb.query<QuoteRow>(
    `SELECT ${COLUMNS} FROM quotes WHERE submission_id = $1 ORDER BY version DESC`, [submissionId]);
  return rows;
}

export type QuoteFilter = { status?: QuoteRow["status"] | null; submissionIds?: string[] | null };

/** Every quote version, newest first; optionally one status (issued = out, not yet bound or superseded) and/or given submissions. */
export async function listQuotes(f: QuoteFilter = {}): Promise<QuoteRow[]> {
  const { rows } = await policyDb.query<QuoteRow>(
    `SELECT ${COLUMNS} FROM quotes
     WHERE ($1::text IS NULL OR status = $1) AND ($2::text[] IS NULL OR submission_id::text = ANY($2))
     ORDER BY issued_at DESC`, [f.status ?? null, f.submissionIds ?? null]);
  return rows;
}

export async function getQuoteMemo(id: string) {
  if (!isUuid(id)) return null;
  const { rows } = await policyDb.query<{ quote_number: string; version: number; pdf: Buffer | null }>(
    "SELECT quote_number, version, memo_pdf AS pdf FROM quotes WHERE id = $1", [id]);
  return rows[0]?.pdf ? rows[0] as { quote_number: string; version: number; pdf: Buffer } : null;
}

export async function getQuotePdf(id: string) {
  if (!isUuid(id)) return null;
  const { rows } = await policyDb.query<{ quote_number: string; version: number; pdf: Buffer }>(
    "SELECT quote_number, version, pdf FROM quotes WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export type QuoteForm = { effective_date: string; expiration_date: string; subjectivities: string };

/**
 * Issue a quote from a ready-to-quote worksheet. Rates again through the rating API,
 * pinned to the rate version the underwriter saw, so the quote records its own rating_id.
 * `at` back-dates the issue (seeded history); it defaults to now.
 */
export async function issueQuote(sub: SubmissionRow, form: QuoteForm, actor: string, at: Date | null = null): Promise<QuoteRow> {
  const ws = await getWorksheet(sub.id);
  if (!ws) throw new Error("Open the workbench and rate first");
  const { effective, expiration } = quotePeriod(form);
  const active = await activeRateVersion();
  if (!active) throw new Error("The rating service isn't reachable, so the rate version can't be confirmed. Try again shortly.");
  const { ready, openReferrals, rated, staleRates } = readiness(sub, ws, active);
  if (staleRates) throw new Error(`Rates changed since this rating (${staleRates.from} → ${staleRates.to}). Save & rate again.`);
  if (!rated) throw new Error("The worksheet changed since it was rated. Save & rate first.");
  if (!ready) throw new Error(`Clear open referrals first: ${openReferrals.map((f) => f.title).join(", ")}`);
  const seen = ws.last_rating!;

  const previous = (await quotesForSubmission(sub.id))[0];
  if (previous?.status === "bound") throw new Error(`${previous.quote_number} is already bound; changes now need a policy endorsement`);
  const issuedAt = at ?? new Date();
  const quoteNumber = previous?.quote_number ?? (await policyDb.query<{ n: string }>(
    `SELECT 'Q-' || $1 || '-' || ${paddedSeq("quote_number_seq", 4)} AS n`, [String(issuedAt.getUTCFullYear())])).rows[0].n;
  const version = (previous?.version ?? 0) + 1;

  // Re-rated pinned to the rate version the worksheet shows, so the quote is exactly what the underwriter saw.
  const rating = await rateOn(ws.rating_inputs, ws.schedule, seen.rate_version_id, `${quoteNumber} v${version}`, actor, at);
  if (rating.total !== seen.total) {
    throw new Error(`Rating returned ${money(rating.total)} but the worksheet shows ${money(seen.total)}. Save & rate again.`);
  }

  const a = sub.data.applicant ?? {};
  const producer = producerFields(sub.data.producer ?? {});
  const inputs = ws.rating_inputs;
  const terms = {
    insured_address: [String(a.street ?? ""), [a.city, a.state].filter(Boolean).join(", ") + (a.zip ? ` ${a.zip}` : "")].filter((l) => l.trim()),
    producer: producerLines(producer),
    producer_fields: producer,
    limits: quoteLimits(inputs),
    deductible: inputs.deductible,
    class_code: inputs.class_code,
    class_description: rating.class_description,
    operations: String(sub.data.operations?.description ?? ""),
    forms: formsFor(inputs),
  };
  const subjectivities = parseSubjectivities(form.subjectivities);
  const validUntil = addDays(issuedAt.toISOString().slice(0, 10), QUOTE_VALID_DAYS);

  const pdf = await renderQuotePdf({
    quoteNumber, version, issuedAt, validUntil, issuedBy: actor,
    insuredName: sub.applicant_name, insuredAddress: terms.insured_address, producer: terms.producer,
    effectiveDate: effective, expirationDate: expiration, limits: terms.limits, deductible: terms.deductible,
    classCode: terms.class_code, classDescription: terms.class_description, operations: terms.operations,
    states: inputs.states, grossReceipts: inputs.gross_receipts,
    premium: Number(rating.premium), policyFee: Number(rating.policy_fee), surplusLinesTax: Number(rating.surplus_lines_tax),
    surplusLinesTaxRate: Number(rating.surplus_lines_tax_rate), homeState: inputs.home_state, total: Number(rating.total),
    rateVersion: rating.rate_version, subjectivities, forms: terms.forms, renewalOf: sub.renewal_of?.policy_number,
    // UX-016: a revised quote says which version it replaces.
    supersedes: previous ? { version: previous.version, issuedAt: previous.issued_at.toISOString().slice(0, 10) } : undefined,
  });

  // A renewal quote comes with a memo to the insured: premium change, what changed in the rating
  // basis, and any rate changes. The comparison it's built from is stored with the quote too.
  let memo: Uint8Array | null = null;
  let comparison: Comparison | null = null;
  const exp = sub.kind === "renewal" ? sub.renewal_of : null;
  if (exp) {
    comparison = compareRenewal(
      { inputs: exp.rating_inputs, schedule: exp.schedule, rating: exp.rating, effective_date: exp.effective_date, expiration_date: exp.expiration_date },
      { inputs, schedule: ws.schedule, rating, effective_date: effective, expiration_date: expiration },
      ws.bridge_rating,
    );
    memo = await renderRenewalMemoPdf({
      quoteNumber, version, issuedAt, validUntil, issuedBy: actor,
      insuredName: sub.applicant_name, insuredAddress: terms.insured_address, producer: terms.producer,
      expiringPolicyNumber: exp.policy_number, expiringPeriod: [exp.effective_date, exp.expiration_date],
      renewingPeriod: [effective, expiration], comparison, limits: terms.limits, deductible: terms.deductible,
      classCode: terms.class_code, classDescription: terms.class_description, subjectivities,
    });
  }

  const client = await policyDb.connect();
  let quote: QuoteRow;
  try {
    await client.query("BEGIN");
    // What the rating and PDF above were built on was read without a lock, so check it still holds. The row locks
    // keep a bind out (CR-050). A file's first quote has no row to lock, hence the per-submission lock too (CR-019).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sub.id]);
    const current = (await client.query<{ quote_number: string; version: number; status: QuoteRow["status"] }>(
      "SELECT quote_number, version, status FROM quotes WHERE submission_id = $1 ORDER BY version DESC FOR UPDATE", [sub.id])).rows;
    const bound = current.find((c) => c.status === "bound");
    if (bound) throw new Error(`${bound.quote_number} is already bound; changes now need a policy endorsement`);
    if ((current[0]?.version ?? 0) !== (previous?.version ?? 0)) {
      throw new Error(`${current[0].quote_number} v${current[0].version} was issued on this file just now. Reload to see it before issuing another.`);
    }
    const superseded = (await client.query<{ id: string; version: number }>(
      "UPDATE quotes SET status = 'superseded' WHERE submission_id = $1 AND status = 'issued' RETURNING id, version", [sub.id])).rows;
    quote = (await client.query<QuoteRow>(
      `INSERT INTO quotes (quote_number, version, status, submission_id, submission_ref, insured_id, insured_name,
         effective_date, expiration_date, valid_until, rating_id, rate_version, rating_inputs, schedule, rating,
         premium, policy_fee, surplus_lines_tax, total, subjectivities, terms, pdf, issued_by, issued_at, memo_pdf, renewal_summary)
       VALUES ($1, $2, 'issued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
       RETURNING ${COLUMNS}`,
      [quoteNumber, version, sub.id, sub.reference, sub.insured_id, sub.applicant_name, effective, expiration, validUntil,
       rating.rating_id, rating.rate_version, inputs, JSON.stringify(ws.schedule), rating,
       rating.premium, rating.policy_fee, rating.surplus_lines_tax, rating.total, subjectivities, terms,
       Buffer.from(pdf), actor, issuedAt, memo ? Buffer.from(memo) : null, comparison],
    )).rows[0];
    const correlationId = crypto.randomUUID();
    // In the transaction, so a quote can't exist without its trail (CR-034); one event per version actually superseded (CR-050).
    await audit([
      ...superseded.map((s) => ({
        actor, action: "quote.superseded", entityType: "quote" as const, entityId: s.id,
        summary: `${quoteNumber} v${s.version} superseded by v${version}`, correlationId, occurredAt: at ?? undefined,
      })),
      {
        actor, action: "quote.issued", entityType: "quote", entityId: quote.id,
        summary: `${quoteNumber} v${version} issued to ${sub.applicant_name}: ${money(rating.total)} total (${sub.reference})${exp ? `, renewal of ${exp.policy_number}${comparison ? `, premium ${changeSummary(comparison.bridge)}` : ""}` : ""}`,
        after: { submission_id: sub.id, rating_id: rating.rating_id, rate_version: rating.rate_version, premium: rating.premium,
          total: rating.total, effective_date: effective, subjectivities }, correlationId, occurredAt: at ?? undefined,
      },
      {
        actor, action: "quote.issued", entityType: "submission", entityId: sub.id,
        summary: `${sub.reference}: quote ${quoteNumber} v${version} issued, ${money(rating.total)} total`, correlationId, occurredAt: at ?? undefined,
      },
    ], client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return quote;
}

export type QuoteDetail = QuoteRow & {
  rating_inputs: RatingInputs; schedule: ScheduleItem[]; rating: Rating; renewal_summary: Comparison | null;
  terms: { insured_address: string[]; producer: string[]; producer_fields?: ProducerFields; limits: { label: string; amount: number }[]; deductible: number;
    class_code: string; class_description: string; operations: string; forms: string[] };
};

/** Everything frozen on a quote except the PDF bytes. */
export async function getQuote(id: string): Promise<QuoteDetail | null> {
  if (!isUuid(id)) return null;
  const { rows } = await policyDb.query<QuoteDetail>(
    `SELECT ${COLUMNS}, rating_inputs, schedule, rating, terms, renewal_summary FROM quotes WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function quoteVersions(quoteNumber: string): Promise<QuoteRow[]> {
  const { rows } = await policyDb.query<QuoteRow>(
    `SELECT ${COLUMNS} FROM quotes WHERE quote_number = $1 ORDER BY version DESC`, [quoteNumber]);
  return rows;
}
