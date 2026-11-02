// Parsing the sub-ledger's query parameters the same way everywhere: the Accounting page, the
// export, the REST API and the MCP tools. Pure module for node:test.
import {
  EXPORT_FORMATS, PERIOD_PRESETS, TRANSACTION_LABEL, presetRange, type ExportFormat, type PeriodPreset, type TransactionType,
} from "./gl-journal.ts";
import { isIsoDate } from "./time.ts";

export type LedgerQuery = {
  period: PeriodPreset;
  from: string | null;       // resolved posting-date range (inclusive), after the preset
  to: string | null;
  type: TransactionType | "";
  batch: string;
  format: ExportFormat;
};

export type ParsedQuery = { query: LedgerQuery; errors: string[] };

/**
 * Validate and resolve. Unknown or malformed values are reported in `errors` and replaced by the
 * default, so callers can either reject (API) or fall back (page). `from`/`to` without a period
 * mean a custom range.
 */
export function parseLedgerQuery(p: Record<string, string | undefined | null>, today: string, defaultPeriod: PeriodPreset = "this_month"): ParsedQuery {
  const errors: string[] = [];
  const get = (k: string) => (p[k] ?? "").toString().trim();

  let period: PeriodPreset = defaultPeriod;
  if (get("period")) {
    if ((PERIOD_PRESETS as readonly string[]).includes(get("period"))) period = get("period") as PeriodPreset;
    else errors.push(`period must be one of ${PERIOD_PRESETS.join(", ")}`);
  } else if (get("from") || get("to")) {
    period = "custom";
  }
  const custom = { from: null as string | null, to: null as string | null };
  for (const k of ["from", "to"] as const) {
    if (!get(k)) continue;
    if (isIsoDate(get(k))) custom[k] = get(k);
    else errors.push(`${k} must be a date formatted YYYY-MM-DD`);
  }
  if (custom.from && custom.to && custom.from > custom.to) errors.push("from must not be after to");

  let type: TransactionType | "" = "";
  if (get("type")) {
    // Not `in`: that also accepts inherited names such as constructor and toString (CR-107).
    if (Object.hasOwn(TRANSACTION_LABEL, get("type"))) type = get("type") as TransactionType;
    else errors.push(`type must be one of ${Object.keys(TRANSACTION_LABEL).join(", ")}`);
  }
  let format: ExportFormat = "json";
  if (get("format")) {
    if ((EXPORT_FORMATS as readonly string[]).includes(get("format"))) format = get("format") as ExportFormat;
    else errors.push(`format must be one of ${EXPORT_FORMATS.join(", ")}`);
  }
  const batch = get("batch");
  if (batch && !/^[A-Za-z0-9-]{1,40}$/.test(batch)) errors.push("batch must be a batch id like GLX-20261030-001");

  const range = presetRange(period, today, custom);
  return { query: { period, from: range.from, to: range.to, type, batch: /^[A-Za-z0-9-]{1,40}$/.test(batch) ? batch : "", format }, errors };
}

/** A push that found no lines to send: no batch is opened and nothing is audited (CR-119). */
export class NothingToPushError extends Error {
  readonly code = "nothing_to_push";
  constructor() {
    super("No lines match this filter, so there is nothing to push. No batch was opened.");
    this.name = "NothingToPushError";
  }
}

/**
 * The query that reads a filter's lines back from GET /api/gl/postings. With no dates it must say
 * `period=all`, or the API falls back to this month (UAT-F1, CR-114). `download` asks for JSON as a file (UAT-F2).
 */
export function ledgerFileQuery(f: Pick<LedgerQuery, "from" | "to" | "type" | "batch">, format: ExportFormat, opts: { download?: boolean } = {}): string {
  const qs = new URLSearchParams();
  if (!f.from && !f.to) qs.set("period", "all");
  if (f.from) qs.set("from", f.from);
  if (f.to) qs.set("to", f.to);
  if (f.type) qs.set("type", f.type);
  if (f.batch) qs.set("batch", f.batch);
  qs.set("format", format);
  if (opts.download) qs.set("download", "1");
  return qs.toString();
}

const accountingFilter = (p: Record<string, string | undefined | null>) => {
  const qs = new URLSearchParams();
  for (const k of ["period", "from", "to", "type", "batch"] as const) if (p[k]) qs.set(k, String(p[k]));
  return qs;
};

/**
 * Where the Accounting page lands after a push (UX-022): the filter the user was looking at, so the
 * file holds the same lines as the page and the audit row (CR-127), plus `pushed_batch`, `pushed`
 * and `format` for the banner and the download. `p` is the posted form (period, from, to, type, batch).
 */
export function pushedAccountingPath(p: Record<string, string | undefined | null>, batch: string, fresh: number, format: ExportFormat): string {
  const qs = accountingFilter(p);
  if (fresh > 0) qs.set("pushed_batch", batch);
  qs.set("pushed", String(fresh));
  qs.set("format", format);
  return `/accounting?${qs}`;
}

/** Back to the same filter, saying why nothing happened: the lines were gone by the time the push ran (CR-119). */
export function nothingToPushPath(p: Record<string, string | undefined | null>): string {
  const qs = accountingFilter(p);
  qs.set("msg", "Nothing to push: no lines match this filter, so no batch was opened.");
  return `/accounting?${qs}`;
}
