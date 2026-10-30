import { EXPORT_FORMATS, GL_TIME_ZONE, PERIOD_PRESETS, PRESET_LABEL, TRANSACTION_LABEL } from "./gl-journal";
import { glOpenApi } from "./gl-openapi";
import { parseLedgerQuery } from "./gl-query";
import {
  GL_API_VERSION, accountsDocument, batchesDocument, journalDocument, periodsDocument, postingsDocument, pushDocument, summaryDocument,
} from "./gl-service";
import { createMcpServer, type McpContext, type ResourceDef, type ToolDef } from "./mcp";

// The MCP server an agent connects to: the sub-ledger as tools and resources, over the same
// service functions as the REST API, so an agent and a GL system see the same numbers.

export const GL_MCP_SERVER = { name: "uwdesk-gl", title: "Underwriting Desktop GL", version: GL_API_VERSION };

const INSTRUCTIONS =
  "Underwriting Desktop's premium sub-ledger: what each underwriting action booked to the general ledger. "
  + "Amounts are USD; posting dates and accounting periods are in America/New_York. Written premium is booked in full on the day a policy "
  + "is bound (no cash or earning view). Use gl_summary for totals, gl_journals for the booked detail, gl_journal to explain one journal "
  + "(its policy and the underwriting action behind it), gl_periods and gl_batches to see what exists and what has been pushed. "
  + "gl_push changes the books' push status (it opens a new GL export batch): call it only when the user asks to push, export or send the sub-ledger to the GL.";

const FILTER_PROPS = {
  period: {
    type: "string", enum: [...PERIOD_PRESETS],
    description: `Posting-date preset (${GL_TIME_ZONE}): ${PERIOD_PRESETS.map((p) => `${p} = ${PRESET_LABEL[p]}`).join(", ")}. Default this_month. Use custom (or just from/to) for an explicit range.`,
  },
  from: { type: "string", format: "date", description: "First posting date of a custom range, inclusive, YYYY-MM-DD" },
  to: { type: "string", format: "date", description: "Last posting date of a custom range, inclusive, YYYY-MM-DD" },
  type: { type: "string", enum: Object.keys(TRANSACTION_LABEL), description: `Only journals of one transaction type: ${Object.entries(TRANSACTION_LABEL).map(([k, v]) => `${k} = ${v}`).join(", ")}` },
};
const BATCH_PROP = { batch: { type: "string", description: "Only the lines stamped with this GL export batch (GLX-YYYYMMDD-NNN), whatever their posting date" } };

/** Validate and resolve the filter arguments; a bad value is a tool error the model can correct. */
function queryOf(args: Record<string, unknown>, ctx: McpContext) {
  const p = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v == null ? undefined : String(v)]));
  const { query, errors } = parseLedgerQuery(p, ctx.today, p.batch ? "all" : "this_month");
  if (errors.length) throw new Error(`Invalid arguments: ${errors.join("; ")}`);
  return query;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const NO_ARGS = { type: "object" as const, properties: {}, additionalProperties: false };

const TOOLS: ToolDef[] = [
  {
    name: "gl_summary", title: "Sub-ledger totals",
    description: "Totals of the premium sub-ledger for a period: written premium (4100), policy fees (4200), surplus lines tax payable (2300), premiums receivable (1200), debits and credits, and journal counts by transaction type, overall and per accounting month. Start here for questions like \"how much premium did we write last month?\".",
    inputSchema: { type: "object", properties: { ...FILTER_PROPS, ...BATCH_PROP }, additionalProperties: false }, annotations: READ_ONLY,
    run: (a, ctx) => summaryDocument(queryOf(a, ctx), ctx),
  },
  {
    name: "gl_journals", title: "Sub-ledger journals",
    description: "The journals booked in a period, each with its policy details (number, insured, dates, quote, submission, underwriter, producer), its debit/credit lines, its GL export batch, and a link to the underwriting action that booked it. Use for the booked detail or to list what was booked.",
    inputSchema: { type: "object", properties: { ...FILTER_PROPS, ...BATCH_PROP }, additionalProperties: false }, annotations: READ_ONLY,
    run: (a, ctx) => postingsDocument(queryOf(a, ctx), ctx),
  },
  {
    name: "gl_journal", title: "One journal, explained",
    description: "One journal (for example JE-000001) with its lines, its policy, whether it balances, when it was pushed, and the audit events of the underwriting action that booked it (the bind: quote bound, policy issued, GL posted). Use to explain why a GL line exists.",
    inputSchema: { type: "object", properties: { journal_no: { type: "string", description: "The journal number, JE- and six digits" } }, required: ["journal_no"], additionalProperties: false }, annotations: READ_ONLY,
    run: async (a, ctx) => {
      const no = String(a.journal_no).trim().toUpperCase();
      const doc = await journalDocument(no, ctx);
      if (!doc) throw new Error(`No journal ${no} has been booked. gl_journals lists the journals of a period.`);
      return doc;
    },
  },
  {
    name: "gl_periods", title: "Accounting periods",
    description: "Every accounting month with bookings, newest first, with its totals and how many of its lines have been pushed to the GL.",
    inputSchema: NO_ARGS, annotations: READ_ONLY, run: (_a, ctx) => periodsDocument(ctx),
  },
  {
    name: "gl_batches", title: "GL export batches",
    description: "Every push to the general ledger, newest first: when, by whom, in which format, what the file held, and which lines that batch was the first to carry.",
    inputSchema: NO_ARGS, annotations: READ_ONLY, run: (_a, ctx) => batchesDocument(ctx),
  },
  {
    name: "gl_accounts", title: "Chart of accounts",
    description: "The four accounts the sub-ledger posts to, the rule a bind posts by, and the transaction types.",
    inputSchema: NO_ARGS, annotations: READ_ONLY, run: async () => accountsDocument(),
  },
  {
    name: "gl_push", title: "Push to the general ledger",
    description: "Push a period's lines to the general ledger, exactly as the button on the Accounting page does: lines not pushed before are stamped with a new batch (GLX-YYYYMMDD-NNN), the push is recorded in the audit trail, and the result names the batch with URLs of the file. Changes the books' push status and is not idempotent: call it only when the user asks to push, export or send the sub-ledger to the GL.",
    inputSchema: { type: "object", properties: { ...FILTER_PROPS, format: { type: "string", enum: [...EXPORT_FORMATS], description: "The file the GL receives; default xlsx" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (a, ctx) => {
      const q = queryOf(a, ctx);
      return (await pushDocument(q, a.format ? q.format : "xlsx", ctx)).document;
    },
  },
];

const RESOURCES: ResourceDef[] = [
  { uri: "uwdesk://gl/accounts", name: "chart-of-accounts", title: "Chart of accounts", description: "The accounts the sub-ledger posts to and the posting rule", mimeType: "application/json",
    read: async () => JSON.stringify(accountsDocument(), null, 2) },
  { uri: "uwdesk://gl/periods", name: "accounting-periods", title: "Accounting periods", description: "Every accounting month with bookings and its totals", mimeType: "application/json",
    read: async (ctx) => JSON.stringify(await periodsDocument(ctx), null, 2) },
  { uri: "uwdesk://gl/openapi.json", name: "rest-api", title: "REST API (OpenAPI 3.1)", description: "The GL REST API's OpenAPI document, for an agent that prefers plain HTTP", mimeType: "application/json",
    read: async (ctx) => JSON.stringify(glOpenApi(ctx.origin), null, 2) },
];

export function glMcpServer() {
  return createMcpServer({ ...GL_MCP_SERVER, instructions: INSTRUCTIONS, tools: TOOLS, resources: RESOURCES });
}
