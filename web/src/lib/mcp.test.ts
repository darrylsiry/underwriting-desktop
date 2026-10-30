import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLedgerQuery } from "./gl-query.ts";
import { PROTOCOL_VERSIONS, createMcpServer, serveMcpHttp, validateArgs, type McpContext } from "./mcp.ts";

const ctx: McpContext = { actor: "underwriter1", origin: "https://example.test", today: "2026-10-30" };

const server = createMcpServer({
  name: "test-gl", version: "0.1", instructions: "GL data.",
  tools: [{
    name: "gl_periods", description: "List periods",
    inputSchema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (args) => ({ periods: ["2026-10"], limit: args.limit ?? null, who: ctx.actor }),
  }, {
    name: "gl_journal", description: "One journal",
    inputSchema: { type: "object", properties: { journal_no: { type: "string" } }, required: ["journal_no"] },
    run: async (args) => { if (args.journal_no !== "JE-000001") throw new Error(`No journal ${args.journal_no}`); return { journal_no: "JE-000001" }; },
  }],
  resources: [{ uri: "uwdesk://gl/accounts", name: "accounts", description: "Chart", mimeType: "application/json", read: async () => '{"1200":"Premiums receivable"}' }],
});

const call = (method: string, params?: unknown, id: number | string = 1) => server.handle({ jsonrpc: "2.0", id, method, params }, ctx);

test("initialize negotiates the protocol version and advertises capabilities", async () => {
  const r = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(r!.id, 1);
  const result = r!.result as { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } };
  assert.equal(result.protocolVersion, "2025-03-26", "a supported older version is honoured");
  assert.ok(result.capabilities.tools);
  assert.equal(result.serverInfo.name, "test-gl");
  const r2 = await call("initialize", { protocolVersion: "1999-01-01" });
  assert.equal((r2!.result as { protocolVersion: string }).protocolVersion, PROTOCOL_VERSIONS[0], "an unknown version gets our latest");
});

test("notifications get no response; unknown methods and bad envelopes get JSON-RPC errors", async () => {
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx), null);
  assert.equal((await call("nope"))!.error!.code, -32601);
  assert.equal((await server.handle({ id: 3, method: "ping" }, ctx))!.error!.code, -32600);
  assert.deepEqual((await call("ping"))!.result, {});
});

test("tools/list and tools/call with structured content", async () => {
  const list = (await call("tools/list"))!.result as { tools: { name: string; annotations?: object }[] };
  assert.deepEqual(list.tools.map((t) => t.name), ["gl_periods", "gl_journal"]);
  assert.deepEqual(list.tools[0].annotations, { readOnlyHint: true });
  const r = (await call("tools/call", { name: "gl_periods", arguments: { limit: 2 } }))!.result as { structuredContent: unknown; content: { type: string; text: string }[]; isError?: boolean };
  assert.deepEqual(r.structuredContent, { periods: ["2026-10"], limit: 2, who: "underwriter1" });
  assert.equal(JSON.parse(r.content[0].text).limit, 2);
  assert.equal(r.isError, undefined);
});

test("tool errors are results, not protocol errors; bad arguments are reported", async () => {
  const missing = (await call("tools/call", { name: "gl_journal", arguments: {} }))!.result as { isError: boolean; content: { text: string }[] };
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /journal_no is required/);
  const thrown = (await call("tools/call", { name: "gl_journal", arguments: { journal_no: "JE-9" } }))!.result as { isError: boolean; content: { text: string }[] };
  assert.equal(thrown.isError, true);
  assert.match(thrown.content[0].text, /No journal JE-9/);
  assert.equal((await call("tools/call", { name: "nothing" }))!.error!.code, -32602);
  assert.deepEqual(validateArgs({ type: "object", properties: { f: { type: "string", enum: ["a", "b"] } } }, { f: "c" }), ["f must be one of a, b"]);
});

test("resources list and read", async () => {
  const list = (await call("resources/list"))!.result as { resources: { uri: string }[] };
  assert.equal(list.resources[0].uri, "uwdesk://gl/accounts");
  const read = (await call("resources/read", { uri: "uwdesk://gl/accounts" }))!.result as { contents: { text: string; mimeType: string }[] };
  assert.equal(JSON.parse(read.contents[0].text)["1200"], "Premiums receivable");
  assert.equal((await call("resources/read", { uri: "uwdesk://nope" }))!.error!.code, -32002);
});

test("ledger query parsing resolves presets and reports bad values", () => {
  const ok = parseLedgerQuery({ period: "last_month", type: "renewal", format: "csv" }, "2026-10-30");
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.query, { period: "last_month", from: "2026-09-01", to: "2026-09-30", type: "renewal", batch: "", format: "csv" });
  const custom = parseLedgerQuery({ from: "2026-01-01", to: "2026-03-31" }, "2026-10-30");
  assert.equal(custom.query.period, "custom");
  assert.deepEqual([custom.query.from, custom.query.to], ["2026-01-01", "2026-03-31"]);
  const bad = parseLedgerQuery({ period: "yesterday", from: "01/02/2026", type: "refund", format: "pdf", batch: "x y" }, "2026-10-30");
  assert.equal(bad.errors.length, 5);
  assert.equal(bad.query.period, "this_month", "falls back to the default");
  assert.deepEqual(parseLedgerQuery({}, "2026-10-30", "all").query.from, null);
});

const http = (method: string, body: unknown, headers: Record<string, string> = {}) => {
  const h = new Map(Object.entries({ "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return serveMcpHttp(server, { method, headers: { get: (n) => h.get(n.toLowerCase()) ?? null }, body: body === null ? null : typeof body === "string" ? body : JSON.stringify(body) }, ctx, { origin: "https://example.test", path: "/api/mcp" });
};

test("streamable HTTP: a request gets JSON, a notification 202, a batch an array", async () => {
  const one = await http("POST", { jsonrpc: "2.0", id: 7, method: "ping" });
  assert.equal(one.status, 200);
  assert.deepEqual(JSON.parse(one.body!), { jsonrpc: "2.0", id: 7, result: {} });
  const note = await http("POST", { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  assert.equal(note.body, null);
  const batch = await http("POST", [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const out = JSON.parse(batch.body!) as { id: number }[];
  assert.deepEqual(out.map((r) => r.id), [1, 2], "notifications produce no entry");
});

test("streamable HTTP: GET describes the server unless an SSE stream is wanted; DELETE, bad JSON, wrong type and foreign origins are refused", async () => {
  const describe = await http("GET", null, { accept: "application/json" });
  assert.equal(describe.status, 200);
  const d = JSON.parse(describe.body!);
  assert.equal(d.endpoint, "https://example.test/api/mcp");
  assert.equal(d.tools.length, 2);
  assert.equal((await http("GET", null)).status, 405, "no server-initiated stream");
  assert.equal((await http("DELETE", null)).status, 405);
  const bad = await http("POST", "{not json");
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body!).error.code, -32700);
  assert.equal((await http("POST", { jsonrpc: "2.0", id: 1, method: "ping" }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await http("POST", { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await http("POST", { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://example.test" })).status, 200);
});
