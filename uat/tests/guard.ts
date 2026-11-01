import { test as base, expect, type APIRequestContext, type BrowserContext, type Request } from "@playwright/test";
import fs from "node:fs";

/**
 * The read-only fixture: every test under tests/readonly uses `test` from here.
 *
 * Production safety is enforced in three layers, so no single mistake in a test can write:
 *  1. The browser: every request leaving the page goes through `context.route`. GET, HEAD and
 *     OPTIONS pass. Anything else is aborted before it leaves the machine and logged as a
 *     "blocked write", unless it is on READ_ONLY_POSTS (POSTs that only read, checked by body).
 *  2. The API client: the `api` fixture only has get(), plus mcp() which sends JSON-RPC methods
 *     on the read-only list. The raw `request`, `page.request` and `context.request` objects,
 *     which bypass routing, throw on any non-GET call.
 *  3. scripts/uat.sh refuses to start the read-only suite if a spec file calls post/put/patch/
 *     delete/fetch directly.
 * Signing in: an Authorization: Basic header on every request (the middleware accepts it), so
 * the sign-in form, which records a login row, is never submitted in read-only mode.
 */

export const USER = process.env.UAT_USER ?? "uat";
const PASS = process.env.UAT_PASS ?? "uat-sandbox-pass";
export const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
export const IS_PROD = !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(process.env.UAT_BASE_URL ?? "http://127.0.0.1:3900");
const BLOCKED_LOG = `.work/blocked-${process.env.UAT_PASS_NAME ?? "readonly"}.jsonl`;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// MCP JSON-RPC methods that only read. gl_push is the one tool that writes, and is never allowed.
const MCP_READ_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "resources/list",
  "resources/templates/list", "resources/read", "prompts/list"]);
const MCP_READ_TOOLS = new Set(["gl_summary", "gl_journals", "gl_journal", "gl_periods", "gl_batches", "gl_accounts"]);

export function mcpBodyIsReadOnly(body: string | null): boolean {
  if (!body) return false;
  let msg: unknown;
  try { msg = JSON.parse(body); } catch { return false; }
  const msgs = Array.isArray(msg) ? msg : [msg];
  return msgs.length > 0 && msgs.every((m) => {
    if (!m || typeof m !== "object") return false;
    const { method, params } = m as { method?: string; params?: { name?: string } };
    if (method && MCP_READ_METHODS.has(method)) return true;
    return method === "tools/call" && !!params?.name && MCP_READ_TOOLS.has(params.name);
  });
}

/** POSTs that only read: the MCP endpoint with read-only methods, and the AI assistant (its tools only query). */
function readOnlyPost(req: Request, origin: string): boolean {
  const u = new URL(req.url());
  if (u.origin !== origin) return false;
  if (u.pathname === "/api/mcp") return mcpBodyIsReadOnly(req.postData());
  if (u.pathname === "/assistant/ask") return !req.headers()["next-action"];
  return false;
}

export type Blocked = { method: string; url: string; action: string | null; test: string; at: string };

async function guardContext(context: BrowserContext, origin: string, blocked: Blocked[], testTitle: string) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (SAFE_METHODS.has(req.method()) || readOnlyPost(req, origin)) return route.continue();
    const entry: Blocked = { method: req.method(), url: req.url(), action: req.headers()["next-action"] ?? null, test: testTitle, at: new Date().toISOString() };
    blocked.push(entry);
    fs.mkdirSync(".work", { recursive: true });
    fs.appendFileSync(BLOCKED_LOG, JSON.stringify(entry) + "\n");
    return route.abort("blockedbyclient");
  });
  // Close the side doors: these clients do not go through context.route.
  lockToGet(context.request, "context.request");
}

function lockToGet(client: APIRequestContext, name: string) {
  for (const m of ["post", "put", "patch", "delete"] as const) {
    (client as unknown as Record<string, unknown>)[m] = () => { throw new Error(`UAT read-only mode: ${name}.${m}() is not allowed`); };
  }
  const fetchFn = client.fetch.bind(client);
  (client as unknown as Record<string, unknown>).fetch = (url: string | Request, opts?: { method?: string }) => {
    const method = (opts?.method ?? "GET").toUpperCase();
    if (!SAFE_METHODS.has(method)) throw new Error(`UAT read-only mode: ${name}.fetch(${method}) is not allowed`);
    return fetchFn(url as string, opts);
  };
}

export type SafeApi = {
  get: APIRequestContext["get"];
  /** One JSON-RPC message to /api/mcp; refused unless it only reads. Returns the parsed reply. */
  mcp: (method: string, params?: Record<string, unknown>, id?: number) => Promise<{ status: number; body: unknown; sessionId: string | null }>;
};

export const test = base.extend<{ blocked: Blocked[]; api: SafeApi }>({
  extraHTTPHeaders: [{ Authorization: AUTH }, { option: true }],
  blocked: async ({}, use) => use([]),
  context: async ({ context, baseURL, blocked }, use, info) => {
    await guardContext(context, new URL(baseURL!).origin, blocked, info.titlePath.slice(1).join(" › "));
    await use(context);
  },
  page: async ({ page }, use) => {
    lockToGet(page.request, "page.request");
    await use(page);
  },
  request: async ({ request }, use) => {
    lockToGet(request, "request");
    await use(request);
  },
  api: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: AUTH } });
    let session: string | null = null;
    const api: SafeApi = {
      get: ctx.get.bind(ctx),
      mcp: async (method, params = {}, id = 1) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        if (!mcpBodyIsReadOnly(body)) throw new Error(`UAT read-only mode: MCP ${method} ${(params as { name?: string }).name ?? ""} is not on the read-only list`);
        const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
        if (session) headers["Mcp-Session-Id"] = session;
        // The one POST the read-only suite sends, and only after mcpBodyIsReadOnly passed.
        const res = await ctx.fetch("/api/mcp", { method: "POST", data: body, headers });
        session = res.headers()["mcp-session-id"] ?? session;
        const text = await res.text();
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch {
          const line = text.split("\n").find((l) => l.startsWith("data: "));
          if (line) parsed = JSON.parse(line.slice(6));
        }
        return { status: res.status(), body: parsed, sessionId: session };
      },
    };
    await use(api);
    await ctx.dispose();
  },
});

export { expect };

/** Fail on page errors and 5xx responses while the callback runs (React errors, broken assets). */
export async function watchPage(page: import("@playwright/test").Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_BLOCKED_BY_CLIENT|blockedbyclient|Failed to load resource.*(401|blocked)/i.test(m.text())) problems.push(`console error: ${m.text().slice(0, 300)}`); });
  page.on("response", (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  return problems;
}
