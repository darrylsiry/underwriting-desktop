// Parsing the sub-ledger's query parameters the same way everywhere: the Accounting page, the
// export, the REST API and the MCP tools. Pure module for node:test.
import {
  EXPORT_FORMATS, PERIOD_PRESETS, TRANSACTION_LABEL, presetRange, type ExportFormat, type PeriodPreset, type TransactionType,
} from "./gl-journal.ts";

export type LedgerQuery = {
  period: PeriodPreset;
  from: string | null;       // resolved posting-date range (inclusive), after the preset
  to: string | null;
  type: TransactionType | "";
  batch: string;
  format: ExportFormat;
};

export type ParsedQuery = { query: LedgerQuery; errors: string[] };

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

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
    if (isDate(get(k))) custom[k] = get(k);
    else errors.push(`${k} must be a date formatted YYYY-MM-DD`);
  }
  if (custom.from && custom.to && custom.from > custom.to) errors.push("from must not be after to");

  let type: TransactionType | "" = "";
  if (get("type")) {
    if (get("type") in TRANSACTION_LABEL) type = get("type") as TransactionType;
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
