// General-ledger rules for the premium sub-ledger: the chart of accounts, the journal a bound
// policy books, accounting periods and the period presets an accountant filters by. Pure module
// (no imports) so node:test can load it.

/** The version the GL API, its OpenAPI document and the MCP server all report. */
export const GL_API_VERSION = "1.0.0";

/** Where the books are kept: accounting periods and "today" follow this zone, not the server's. */
export const GL_TIME_ZONE = "America/New_York";

export type Account = { code: string; name: string; kind: "asset" | "liability" | "revenue" };

export const ACCOUNTS = {
  receivable: { code: "1200", name: "Premiums receivable", kind: "asset" },
  premium: { code: "4100", name: "Written premium - E&S contractors GL", kind: "revenue" },
  fee: { code: "4200", name: "Policy fee income", kind: "revenue" },
  tax: { code: "2300", name: "Surplus lines tax payable", kind: "liability" },
} as const satisfies Record<string, Account>;

export type TransactionType = "new_business" | "renewal" | "endorsement" | "cancellation";

export const TRANSACTION_LABEL: Record<TransactionType, string> = {
  new_business: "New business", renewal: "Renewal", endorsement: "Endorsement", cancellation: "Cancellation",
};

export type JournalLine = { line_no: number; account_code: string; account_name: string; debit: number; credit: number };

export type PolicyAmounts = { premium: number | string; policy_fee: number | string; surplus_lines_tax: number | string; total: number | string };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The journal a bound policy books, on a written basis at bind: the full amount due is receivable,
 * premium and fee are revenue, surplus lines tax is owed to the state. Lines for zero amounts are
 * left out. Debits always equal credits. (Endorsements and cancellations will post the same
 * accounts with negative or reversed amounts.)
 */
export function bindJournal(a: PolicyAmounts): JournalLine[] {
  const premium = round2(Number(a.premium)), fee = round2(Number(a.policy_fee)), tax = round2(Number(a.surplus_lines_tax));
  const total = round2(Number(a.total));
  if (round2(premium + fee + tax) !== total) throw new Error(`Policy amounts don't add up: ${premium} + ${fee} + ${tax} != ${total}`);
  const lines: JournalLine[] = [
    { line_no: 1, account_code: ACCOUNTS.receivable.code, account_name: ACCOUNTS.receivable.name, debit: total, credit: 0 },
    { line_no: 2, account_code: ACCOUNTS.premium.code, account_name: ACCOUNTS.premium.name, debit: 0, credit: premium },
    { line_no: 3, account_code: ACCOUNTS.fee.code, account_name: ACCOUNTS.fee.name, debit: 0, credit: fee },
    { line_no: 4, account_code: ACCOUNTS.tax.code, account_name: ACCOUNTS.tax.name, debit: 0, credit: tax },
  ];
  return lines.filter((l) => l.debit !== 0 || l.credit !== 0).map((l, i) => ({ ...l, line_no: i + 1 }));
}

export function isBalanced(lines: { debit: number | string; credit: number | string }[]): boolean {
  const d = lines.reduce((n, l) => n + Number(l.debit), 0), c = lines.reduce((n, l) => n + Number(l.credit), 0);
  return round2(d) === round2(c);
}

/** YYYY-MM-DD of an instant in the books' time zone. */
export function glDate(at: Date, timeZone = GL_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The accounting period (YYYY-MM) an instant falls in, in the books' time zone. */
export function accountingPeriod(at: Date, timeZone = GL_TIME_ZONE): string {
  return glDate(at, timeZone).slice(0, 7);
}

export const EXPORT_FORMATS = ["xlsx", "csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const PERIOD_PRESETS = ["this_month", "last_month", "this_quarter", "last_quarter", "ytd", "last_12", "all", "custom"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export const PRESET_LABEL: Record<PeriodPreset, string> = {
  this_month: "This month", last_month: "Last month", this_quarter: "This quarter", last_quarter: "Last quarter",
  ytd: "Year to date", last_12: "Last 12 months", all: "All periods", custom: "Custom range",
};

export type DateRange = { from: string | null; to: string | null };

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-12
const monthStart = (y: number, m: number) => ymd(y, m, 1);
const monthEnd = (y: number, m: number) => ymd(y, m, daysInMonth(y, m));
const shiftMonth = (y: number, m: number, by: number): [number, number] => {
  const i = y * 12 + (m - 1) + by;
  return [Math.floor(i / 12), (i % 12) + 1];
};

/** Inclusive date range for a preset, given today's date in the books' time zone. */
export function presetRange(preset: PeriodPreset, today: string, custom: DateRange = { from: null, to: null }): DateRange {
  const [y, m] = today.split("-").map(Number);
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;   // first month of this quarter
  switch (preset) {
    case "this_month": return { from: monthStart(y, m), to: monthEnd(y, m) };
    case "last_month": { const [ly, lm] = shiftMonth(y, m, -1); return { from: monthStart(ly, lm), to: monthEnd(ly, lm) }; }
    case "this_quarter": return { from: monthStart(y, q0), to: monthEnd(y, q0 + 2) };
    case "last_quarter": { const [qy, qm] = shiftMonth(y, q0, -3); return { from: monthStart(qy, qm), to: monthEnd(qy, qm + 2) }; }
    case "ytd": return { from: ymd(y, 1, 1), to: today };
    case "last_12": { const [sy, sm] = shiftMonth(y, m, -11); return { from: monthStart(sy, sm), to: monthEnd(y, m) }; }
    case "all": return { from: null, to: null };
    case "custom": return { from: custom.from || null, to: custom.to || null };
  }
}

/** "Oct 2026" for a YYYY-MM period. */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}
