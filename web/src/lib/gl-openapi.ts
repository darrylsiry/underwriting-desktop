// The OpenAPI 3.1 description of the GL API, rendered as the docs page and served at
// /api/gl/openapi.json. Built from the same constants the routes validate against, so the
// enums can't drift. Pure module for node:test.
import { ACCOUNTS, EXPORT_FORMATS, GL_TIME_ZONE, PERIOD_PRESETS, PRESET_LABEL, TRANSACTION_LABEL } from "./gl-journal.ts";

export type Parameter = {
  name: string; in: "query" | "path"; required?: boolean; description: string;
  schema: { type: string; enum?: readonly string[]; format?: string; pattern?: string; default?: string; example?: string };
};
export type MediaType = { schema: unknown; example?: unknown };
export type ResponseDef = { description: string; content?: Record<string, MediaType>; headers?: Record<string, { description: string; schema: { type: string } }> };
export type Operation = {
  operationId: string; summary: string; description: string; tags: string[];
  parameters?: Parameter[];
  requestBody?: { required: boolean; description: string; content: Record<string, MediaType> };
  responses: Record<string, ResponseDef>;
  /** A query string the docs page offers as a one-click "try it" for GET operations. */
  "x-try"?: string;
};
export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string; summary: string; description: string };
  servers: { url: string; description: string }[];
  security: Record<string, string[]>[];
  tags: { name: string; description: string }[];
  paths: Record<string, Partial<Record<"get" | "post", Operation>>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
};

export const GL_API_VERSION = "1.0.0";

const presetList = PERIOD_PRESETS.map((p) => `\`${p}\` (${PRESET_LABEL[p]})`).join(", ");
const typeList = Object.entries(TRANSACTION_LABEL).map(([k, v]) => `\`${k}\` (${v})`).join(", ");

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, example?: unknown): Record<string, MediaType> => ({ "application/json": { schema, ...(example === undefined ? {} : { example }) } });
const errorResponse = (description: string): ResponseDef => ({ description, content: json(ref("Error")) });

const FILTER_PARAMS: Parameter[] = [
  { name: "period", in: "query", description: `Posting-date preset, resolved in ${GL_TIME_ZONE}: ${presetList}. Default \`this_month\` (\`all\` when \`batch\` is given). Use \`custom\`, or just \`from\`/\`to\`, for an explicit range.`,
    schema: { type: "string", enum: PERIOD_PRESETS, default: "this_month" } },
  { name: "from", in: "query", description: "First posting date (inclusive, YYYY-MM-DD) of a custom range. Ignored with a preset other than `custom`.", schema: { type: "string", format: "date", example: "2026-10-01" } },
  { name: "to", in: "query", description: "Last posting date (inclusive, YYYY-MM-DD) of a custom range.", schema: { type: "string", format: "date", example: "2026-10-31" } },
  { name: "type", in: "query", description: `Only journals of one transaction type: ${typeList}.`, schema: { type: "string", enum: Object.keys(TRANSACTION_LABEL) } },
  { name: "batch", in: "query", description: "Only the lines stamped with this GL export batch (`GLX-YYYYMMDD-NNN`), whatever their posting date.", schema: { type: "string", pattern: "^[A-Za-z0-9-]{1,40}$", example: "GLX-20261030-001" } },
];
const FORMAT_PARAM: Parameter = {
  name: "format", in: "query", description: "`json` (default) answers with journals and their lines; `csv` and `xlsx` answer with the same file the Accounting page's push produces, one row per journal line.",
  schema: { type: "string", enum: EXPORT_FORMATS, default: "json" },
};

const money = { type: "number", description: "USD, two decimals" };
const SCHEMAS: Record<string, unknown> = {
  Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: {
    code: { type: "string", enum: ["bad_request", "not_found", "unauthorized"] }, message: { type: "string" }, details: { type: "array", items: { type: "string" } } } } } },
  Filter: { type: "object", properties: {
    period: { type: ["string", "null"], enum: [...PERIOD_PRESETS, null] }, period_label: { type: "string" },
    posting_date_from: { type: ["string", "null"], format: "date" }, posting_date_to: { type: ["string", "null"], format: "date" },
    transaction_type: { type: ["string", "null"], enum: [...Object.keys(TRANSACTION_LABEL), null] }, export_batch: { type: ["string", "null"] } } },
  Totals: { type: "object", properties: {
    journals: { type: "integer" }, lines: { type: "integer" }, debit: money, credit: money, written_premium: { ...money, description: `Account ${ACCOUNTS.premium.code}` },
    policy_fees: { ...money, description: `Account ${ACCOUNTS.fee.code}` }, surplus_lines_tax: { ...money, description: `Account ${ACCOUNTS.tax.code}` },
    premiums_receivable: { ...money, description: `Account ${ACCOUNTS.receivable.code}` },
    by_type: { type: "object", additionalProperties: { type: "object", properties: { label: { type: "string" }, journals: { type: "integer" } } } } } },
  JournalLine: { type: "object", required: ["line_no", "account_code", "account_name", "debit", "credit"], properties: {
    line_no: { type: "integer" }, account_code: { type: "string", enum: Object.values(ACCOUNTS).map((a) => a.code) }, account_name: { type: "string" }, debit: money, credit: money } },
  Journal: { type: "object", required: ["journal_no", "posted_at", "accounting_period", "transaction_type", "lines"], properties: {
    journal_no: { type: "string", example: "JE-000001" }, posted_at: { type: "string", format: "date-time" }, accounting_period: { type: "string", example: "2026-10" },
    transaction_type: { type: "string", enum: Object.keys(TRANSACTION_LABEL) }, description: { type: "string" }, export_batch: { type: ["string", "null"] },
    policy: { type: "object", properties: { number: { type: "string" }, insured: { type: "string" }, effective_date: { type: "string", format: "date" }, expiration_date: { type: "string", format: "date" },
      quote: { type: "string" }, submission: { type: "string" }, underwriter: { type: "string" }, producer: { type: "string" }, url: { type: "string", format: "uri" } } },
    source: { type: "object", description: "The underwriting action that booked the journal", properties: { action: { type: "string", example: "policy.bound" }, correlation_id: { type: "string" }, audit_url: { type: "string", format: "uri" } } },
    lines: { type: "array", items: ref("JournalLine") } } },
  LedgerDocument: { type: "object", description: "The sub-ledger for a filter: journals with their lines, and totals that reconcile against them.", properties: {
    source: { type: "string" }, basis: { type: "string" }, batch: { type: ["string", "null"], description: "The batch a push stamped; null for a read" },
    generated_at: { type: "string", format: "date-time" }, generated_by: { type: "string", description: "The authenticated user" }, time_zone: { type: "string" },
    filter: ref("Filter"), totals: ref("Totals"), journals: { type: "array", items: ref("Journal") } } },
  Summary: { type: "object", properties: { generated_at: { type: "string", format: "date-time" }, generated_by: { type: "string" }, time_zone: { type: "string" }, currency: { type: "string" },
    filter: ref("Filter"), totals: ref("Totals"),
    periods: { type: "array", items: { allOf: [ref("Totals"), { type: "object", properties: { period: { type: "string", example: "2026-10" }, label: { type: "string", example: "Oct 2026" }, url: { type: "string", format: "uri" } } }] } } } },
  JournalDetail: { type: "object", properties: {
    generated_at: { type: "string", format: "date-time" }, generated_by: { type: "string" }, time_zone: { type: "string" }, currency: { type: "string" },
    journal: { allOf: [ref("Journal"), { type: "object", properties: { balanced: { type: "boolean" }, debit: money, credit: money, exported_at: { type: ["string", "null"], format: "date-time" }, exported_by: { type: ["string", "null"] } } }] },
    underwriting_action: { type: "object", properties: { correlation_id: { type: "string" }, audit_url: { type: "string", format: "uri" },
      events: { type: "array", items: { type: "object", properties: { occurred_at: { type: "string", format: "date-time" }, actor: { type: "string" }, action: { type: "string" }, entity_type: { type: "string" }, entity_id: { type: "string" }, summary: { type: "string" } } } } } } } },
  Periods: { type: "object", properties: { generated_at: { type: "string", format: "date-time" }, time_zone: { type: "string" }, currency: { type: "string" },
    periods: { type: "array", items: { type: "object", properties: { period: { type: "string" }, label: { type: "string" }, journals: { type: "integer" }, lines: { type: "integer" }, debit: money, credit: money,
      written_premium: money, policy_fees: money, surplus_lines_tax: money, premiums_receivable: money, pushed_lines: { type: "integer" }, unpushed_lines: { type: "integer" },
      first_posted_at: { type: "string", format: "date-time" }, last_posted_at: { type: "string", format: "date-time" }, url: { type: "string", format: "uri", description: "The postings of this month" } } } } } },
  Batches: { type: "object", properties: { generated_at: { type: "string", format: "date-time" }, time_zone: { type: "string" }, currency: { type: "string" },
    batches: { type: "array", items: { type: "object", properties: { batch: { type: "string" }, exported_at: { type: "string", format: "date-time" }, exported_by: { type: "string" }, format: { type: ["string", "null"], enum: [...EXPORT_FORMATS, null] },
      filter: { type: "object", properties: { posting_date_from: { type: ["string", "null"] }, posting_date_to: { type: ["string", "null"] }, transaction_type: { type: ["string", "null"] } } },
      lines_in_file: { type: ["integer", "null"] }, journals_in_file: { type: ["integer", "null"] }, lines_stamped: { type: "integer", description: "Lines this batch was the first to push" }, journals_stamped: { type: "integer" },
      debit_stamped: { type: ["number", "null"] }, credit_stamped: { type: ["number", "null"] }, url: { type: "string", format: "uri" }, accounting_url: { type: "string", format: "uri" } } } } } },
  Accounts: { type: "object", properties: { currency: { type: "string" }, time_zone: { type: "string" },
    accounts: { type: "array", items: { type: "object", properties: { code: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: ["asset", "liability", "revenue"] }, normal_balance: { type: "string", enum: ["debit", "credit"] } } } },
    posting_rule: { type: "object", properties: { event: { type: "string" }, basis: { type: "string" }, lines: { type: "array", items: { type: "object", properties: { account_code: { type: "string" }, side: { type: "string" }, amount: { type: "string" } } } }, notes: { type: "string" } } },
    transaction_types: { type: "array", items: { type: "object", properties: { code: { type: "string" }, label: { type: "string" }, in_use: { type: "boolean" } } } } } },
  ExportRequest: { type: "object", description: "The same filter as GET /api/gl/postings, plus the file format.", properties: {
    period: { type: "string", enum: PERIOD_PRESETS }, from: { type: "string", format: "date" }, to: { type: "string", format: "date" },
    type: { type: "string", enum: Object.keys(TRANSACTION_LABEL) }, format: { type: "string", enum: EXPORT_FORMATS, default: "json" } } },
  Push: { type: "object", properties: { batch: { type: "string", example: "GLX-20261030-004" }, format: { type: "string", enum: EXPORT_FORMATS }, filename: { type: "string" },
    pushed_at: { type: "string", format: "date-time" }, pushed_by: { type: "string" }, filter: ref("Filter"), lines: { type: "integer" }, journals: { type: "integer" },
    newly_stamped_lines: { type: "integer", description: "Lines pushed for the first time in this batch; the others keep their earlier batch" }, note: { type: "string" },
    file_url: { type: "string", format: "uri" }, batch_url: { type: ["string", "null"], format: "uri" }, accounting_url: { type: "string", format: "uri" }, audit_url: { type: "string", format: "uri" } } },
  PushResult: { type: "object", properties: { push: ref("Push"), ledger: ref("LedgerDocument") } },
  ApiIndex: { type: "object", properties: { name: { type: "string" }, version: { type: "string" }, authenticated_as: { type: "string" }, authentication: { type: "string" },
    documentation: { type: "string", format: "uri" }, openapi: { type: "string", format: "uri" },
    mcp: { type: "object", properties: { endpoint: { type: "string", format: "uri" }, transport: { type: "string" }, documentation: { type: "string", format: "uri" } } },
    endpoints: { type: "object", additionalProperties: { type: "string" } }, time_zone: { type: "string" }, currency: { type: "string" } } },
};

export function glOpenApi(origin: string): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: "Underwriting Desktop GL API", version: GL_API_VERSION,
      summary: "The premium sub-ledger for other systems: what each underwriting action booked to the general ledger.",
      description: `Read the sub-ledger by accounting period, transaction type or export batch, look up one journal and the underwriting action behind it, `
        + `and push a period to the general ledger. Premium is booked in full when a policy is bound (written basis; cash collection and earning are not reflected). `
        + `Amounts are USD. Posting dates and accounting periods follow the books' time zone, ${GL_TIME_ZONE}. `
        + `Every response is generated from the same tables as the Accounting page, so the numbers reconcile.\n\n`
        + `Authentication is HTTP Basic with an Underwriting Desktop login (the same user id and password as the web app). `
        + `Responses that carry \`generated_by\` name the authenticated user. An instance running without the password gate (local development) accepts calls without credentials.`,
    },
    servers: [{ url: origin, description: "This instance" }],
    security: [{ basicAuth: [] }],
    tags: [
      { name: "Sub-ledger", description: "Journals, lines and totals" },
      { name: "Reference", description: "Periods, batches and the chart of accounts" },
      { name: "Push", description: "Sending a period to the general ledger" },
      { name: "Meta", description: "The API about itself" },
    ],
    paths: {
      "/api/gl": { get: { operationId: "index", tags: ["Meta"], summary: "Front door", description: "Links to every endpoint, the documentation, this spec and the MCP server, plus who you are authenticated as. A good first call to check credentials.",
        responses: { "200": { description: "OK", content: json(ref("ApiIndex")) }, "401": errorResponse("Missing or wrong credentials") }, "x-try": "" } },
      "/api/gl/postings": { get: { operationId: "listPostings", tags: ["Sub-ledger"], summary: "Journals for a period", description: "The sub-ledger for a posting-date range, transaction type or export batch: journals with their policy details, the audit link to the underwriting action, and their debit/credit lines. Totals reconcile against the lines. Reads only: nothing is stamped as pushed.",
        parameters: [...FILTER_PARAMS, FORMAT_PARAM],
        responses: {
          "200": { description: "OK", content: { ...json(ref("LedgerDocument")), "text/csv": { schema: { type: "string" } }, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { schema: { type: "string", format: "binary" } } } },
          "400": errorResponse("A parameter is invalid; `details` names each one"), "401": errorResponse("Missing or wrong credentials") },
        "x-try": "period=this_month" } },
      "/api/gl/summary": { get: { operationId: "summary", tags: ["Sub-ledger"], summary: "Totals for a period", description: "The totals the Accounting page's tiles show, overall and per accounting month, without the journal detail.",
        parameters: FILTER_PARAMS,
        responses: { "200": { description: "OK", content: json(ref("Summary")) }, "400": errorResponse("A parameter is invalid"), "401": errorResponse("Missing or wrong credentials") },
        "x-try": "period=ytd" } },
      "/api/gl/journals/{journal_no}": { get: { operationId: "getJournal", tags: ["Sub-ledger"], summary: "One journal", description: "One journal with its lines and the audit events of the underwriting action that booked it (the bind: quote bound, policy issued, GL posted), for an auditor following a GL line back to its cause.",
        parameters: [{ name: "journal_no", in: "path", required: true, description: "The journal number, `JE-` and six digits.", schema: { type: "string", pattern: "^JE-\\d{6,}$", example: "JE-000001" } }],
        responses: { "200": { description: "OK", content: json(ref("JournalDetail")) }, "400": errorResponse("Malformed journal number"), "404": errorResponse("No such journal"), "401": errorResponse("Missing or wrong credentials") },
        "x-try": "" } },
      "/api/gl/periods": { get: { operationId: "listPeriods", tags: ["Reference"], summary: "Accounting periods", description: "Every accounting month with bookings, newest first, with its totals and how many of its lines have been pushed. Each carries the URL of its postings.",
        responses: { "200": { description: "OK", content: json(ref("Periods")) }, "401": errorResponse("Missing or wrong credentials") }, "x-try": "" } },
      "/api/gl/batches": { get: { operationId: "listBatches", tags: ["Reference"], summary: "GL export batches", description: "Every push to the general ledger, newest first: when, by whom, in which format, what the file held, and which lines that batch was the first to carry. Fetch a batch's lines with `GET /api/gl/postings?batch=...`.",
        responses: { "200": { description: "OK", content: json(ref("Batches")) }, "401": errorResponse("Missing or wrong credentials") }, "x-try": "" } },
      "/api/gl/accounts": { get: { operationId: "chartOfAccounts", tags: ["Reference"], summary: "Chart of accounts", description: "The four accounts the sub-ledger posts to, the rule a bind posts by, and the transaction types.",
        responses: { "200": { description: "OK", content: json(ref("Accounts")) }, "401": errorResponse("Missing or wrong credentials") }, "x-try": "" } },
      "/api/gl/exports": { post: { operationId: "pushToGl", tags: ["Push"], summary: "Push a period to the GL", description: "Does what the Accounting page's push button does: renders the filter's lines, stamps the lines not pushed before with a new batch (`GLX-YYYYMMDD-NNN`), and records the push in the audit trail. Lines pushed earlier keep their batch and the file shows which. With `format: json` the answer is the push record plus the ledger document; with `csv` or `xlsx` it is the file, with the batch in the `X-GL-Export-Batch` header. Not idempotent: every call opens a new batch.",
        requestBody: { required: false, description: "The filter and format, as JSON (or the same names as query parameters).", content: json(ref("ExportRequest"), { period: "last_month", format: "json" }) },
        responses: {
          "201": { description: "Pushed (JSON format)", content: json(ref("PushResult")) },
          "200": { description: "Pushed (CSV or Excel file)", headers: { "X-GL-Export-Batch": { description: "The batch this push opened", schema: { type: "string" } }, "X-GL-Newly-Stamped-Lines": { description: "Lines pushed for the first time", schema: { type: "integer" } } },
            content: { "text/csv": { schema: { type: "string" } }, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { schema: { type: "string", format: "binary" } } } },
          "400": errorResponse("A parameter is invalid"), "401": errorResponse("Missing or wrong credentials") } } },
      "/api/gl/openapi.json": { get: { operationId: "openapi", tags: ["Meta"], summary: "This specification", description: "The OpenAPI 3.1 document, with this instance as the server. Import it into Postman, Insomnia, Bruno or a client generator.",
        responses: { "200": { description: "OK", content: json({ type: "object" }) } }, "x-try": "" } },
    },
    components: {
      securitySchemes: { basicAuth: { type: "http", scheme: "basic", description: "An Underwriting Desktop login: the same user id and password as the web app." } },
      schemas: SCHEMAS,
    },
  };
}
