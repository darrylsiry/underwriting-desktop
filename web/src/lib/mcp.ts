// A small Model Context Protocol server core: JSON-RPC 2.0 dispatch for initialize, ping,
// tools/list, tools/call, resources/list, resources/read and prompts/list. Transport-agnostic
// (the HTTP route feeds it messages) and pure apart from the tool code it is given, so
// node:test can drive it with fake tools.

export type JsonRpcId = string | number | null;
export type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** Protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type McpContext = { actor: string; origin: string; today: string };

export type ToolDef<A = Record<string, unknown>> = {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Return the structured result; throw an Error to report a tool error to the model. */
  run: (args: A, ctx: McpContext) => Promise<unknown>;
};

export type ResourceDef = {
  uri: string; name: string; title?: string; description: string; mimeType: string;
  read: (ctx: McpContext) => Promise<string>;
};

export type McpServerOptions = {
  name: string; title?: string; version: string; instructions: string; tools: ToolDef[]; resources: ResourceDef[];
};

const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602, INTERNAL = -32603;

export function parseError(id: JsonRpcId = null, message = "Parse error"): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code: PARSE_ERROR, message } };
}

/** Check the arguments against the tool's (deliberately simple) JSON schema: required keys, enums, types. */
export function validateArgs(schema: ToolDef["inputSchema"], args: unknown): string[] {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return ["arguments must be an object"];
  const a = args as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of schema.required ?? []) if (!(key in a) || a[key] === "" || a[key] === null) errors.push(`${key} is required`);
  for (const [key, value] of Object.entries(a)) {
    const prop = schema.properties[key] as { type?: string; enum?: unknown[] } | undefined;
    if (!prop) { if (schema.additionalProperties === false) errors.push(`unknown argument ${key}`); continue; }
    if (value === undefined || value === null) continue;
    if (prop.type === "string" && typeof value !== "string") errors.push(`${key} must be a string`);
    if (prop.type === "number" && typeof value !== "number") errors.push(`${key} must be a number`);
    if (prop.type === "boolean" && typeof value !== "boolean") errors.push(`${key} must be a boolean`);
    if (prop.enum && !prop.enum.includes(value)) errors.push(`${key} must be one of ${prop.enum.join(", ")}`);
  }
  return errors;
}

export function createMcpServer(o: McpServerOptions) {
  const toolList = o.tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
  const resourceList = o.resources.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType }));

  const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  /** What the spec page shows: the server as a client would see it after initialize and tools/list. */
  function describe() {
    return {
      protocolVersion: PROTOCOL_VERSIONS[0], supportedProtocolVersions: [...PROTOCOL_VERSIONS],
      serverInfo: { name: o.name, title: o.title, version: o.version }, instructions: o.instructions,
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
      tools: toolList, resources: resourceList,
    };
  }

  /** Handle one JSON-RPC message. Notifications (no id) return null: the transport answers 202. */
  async function handle(message: unknown, ctx: McpContext): Promise<JsonRpcResponse | null> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return fail(null, INVALID_REQUEST, "Invalid request");
    const m = message as Partial<JsonRpcRequest>;
    const id: JsonRpcId = m.id === undefined ? null : m.id;
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(id, INVALID_REQUEST, "Invalid request: jsonrpc must be \"2.0\" and method a string");
    const isNotification = m.id === undefined;
    if (isNotification) return null;   // notifications/initialized, notifications/cancelled, ...: acknowledged, nothing to say
    const params = (m.params ?? {}) as Record<string, unknown>;

    try {
      switch (m.method) {
        case "initialize": {
          const asked = String(params.protocolVersion ?? "");
          const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
          const d = describe();
          return ok(id, { protocolVersion, capabilities: d.capabilities, serverInfo: d.serverInfo, instructions: d.instructions });
        }
        case "ping": return ok(id, {});
        case "tools/list": return ok(id, { tools: toolList });
        case "tools/call": {
          const tool = o.tools.find((t) => t.name === params.name);
          if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
          const errors = validateArgs(tool.inputSchema, params.arguments);
          if (errors.length) return ok(id, { content: [{ type: "text", text: `Invalid arguments: ${errors.join("; ")}` }], isError: true });
          try {
            const result = await tool.run((params.arguments ?? {}) as Record<string, unknown>, ctx);
            return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown> });
          } catch (err) {
            return ok(id, { content: [{ type: "text", text: (err as Error).message }], isError: true });
          }
        }
        case "resources/list": return ok(id, { resources: resourceList });
        case "resources/templates/list": return ok(id, { resourceTemplates: [] });
        case "resources/read": {
          const r = o.resources.find((x) => x.uri === params.uri);
          if (!r) return fail(id, -32002, `Resource not found: ${String(params.uri)}`);
          return ok(id, { contents: [{ uri: r.uri, mimeType: r.mimeType, text: await r.read(ctx) }] });
        }
        case "prompts/list": return ok(id, { prompts: [] });
        case "completion/complete": return ok(id, { completion: { values: [] } });
        default: return fail(id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
      }
    } catch (err) {
      return fail(id, INTERNAL, (err as Error).message);
    }
  }

  return { handle, describe };
}

// ---- Streamable HTTP transport (stateless, JSON responses) ----------------------------------

export type HttpRequest = { method: string; headers: { get(name: string): string | null }; body: string | null };
export type HttpResponse = { status: number; headers: Record<string, string>; body: string | null };
export type McpServer = ReturnType<typeof createMcpServer>;

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const httpError = (status: number, message: string, extra: Record<string, string> = {}): HttpResponse =>
  ({ status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }) });

/**
 * Serve one HTTP request of the MCP Streamable HTTP transport. POST carries one JSON-RPC message
 * (or an array of them) and gets JSON back, or 202 when it was only notifications. The server
 * holds no sessions and sends nothing on its own, so GET with an SSE Accept is 405; a plain GET
 * (a browser, curl) gets the server's description instead. `opts.origin` is this instance's
 * public origin: a browser's Origin header must match it (the DNS-rebinding guard the spec asks for).
 */
export async function serveMcpHttp(server: McpServer, req: HttpRequest, ctx: McpContext, opts: { origin: string; path: string }): Promise<HttpResponse> {
  const origin = req.headers.get("origin");
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === new URL(opts.origin).host; } catch { ok = false; }
    if (!ok) return httpError(403, "Forbidden: the Origin header does not match this server");
  }
  const accept = req.headers.get("accept") ?? "";
  if (req.method === "GET") {
    if (accept.includes("text/event-stream")) return httpError(405, "This server opens no server-to-client stream; POST JSON-RPC messages to this endpoint", { Allow: "POST" });
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ endpoint: `${opts.origin}${opts.path}`, transport: "streamable-http", ...server.describe() }, null, 2) };
  }
  if (req.method === "DELETE") return httpError(405, "Stateless server: there is no session to end", { Allow: "GET, POST" });
  if (req.method !== "POST") return httpError(405, "Use POST for JSON-RPC messages", { Allow: "GET, POST" });
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return httpError(415, "Content-Type must be application/json");

  let parsed: unknown;
  try { parsed = JSON.parse(req.body ?? ""); } catch { return { status: 400, headers: JSON_HEADERS, body: JSON.stringify(parseError()) }; }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (!messages.length) return httpError(400, "Empty batch");
  const responses: JsonRpcResponse[] = [];
  for (const m of messages) {
    const r = await server.handle(m, ctx);
    if (r) responses.push(r);
  }
  if (!responses.length) return { status: 202, headers: { "Cache-Control": "no-store" }, body: null };
  return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(Array.isArray(parsed) ? responses : responses[0]) };
}
