import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Card, Code, Crumbs, Json, Pill, btn, btnPrimary } from "@/components/docs";
import { loadUsers } from "@/lib/basic-auth";
import { glMcpServer } from "@/lib/gl-mcp";
import { requestOrigin } from "@/lib/http";
import { listPostings } from "@/lib/ledger";
import { currentUser } from "@/lib/user";
import { McpConsole } from "./mcp-console";

export const metadata: Metadata = { title: "Accounting MCP server" };

export const dynamic = "force-dynamic";

/** The MCP server's specification: endpoint, capabilities, tools, resources, how to connect, and a live session. */
export default async function McpDocsPage() {
  const h = await headers();
  const origin = requestOrigin(h);
  const actor = await currentUser();
  const gated = loadUsers(process.env).size > 0;
  const d = glMcpServer().describe();
  const endpoint = `${origin}/api/mcp`;
  const firstJournal = (await listPostings({ from: null, to: null, type: "", batch: "" }))[0]?.journal_no ?? "JE-000001";
  const curlAuth = gated ? "-u underwriter1 " : "";
  const headerFlag = gated ? ` \\\n  --header "Authorization: Basic $(printf 'underwriter1:PASSWORD' | base64)"` : "";
  const rpcExample = (body: unknown) => `curl ${curlAuth}-X POST "${endpoint}" \\\n  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \\\n  -d '${JSON.stringify(body)}'`;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <Crumbs trail={[{ href: "/accounting", label: "Accounting" }, { label: "MCP server" }]} />
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{d.serverInfo.title} <span className="ml-1 align-middle rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-normal text-slate-600">{d.serverInfo.name} v{d.serverInfo.version}</span></h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            A Model Context Protocol server: the premium sub-ledger as tools and resources an agent can call, over the Streamable HTTP transport, behind the same login as this page.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/api/mcp" target="_blank" rel="noreferrer" className={btnPrimary}>Server description (JSON) ↗</a>
          <Link href="/accounting/api" className={btn}>REST API →</Link>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        <Card title="Endpoint">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
            <dt className="text-slate-500">URL</dt><dd><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{endpoint}</code></dd>
            <dt className="text-slate-500">Transport</dt><dd>Streamable HTTP: <code className="text-xs">POST</code> one JSON-RPC 2.0 message (or a batch) and get JSON back. Stateless: no session id, no server-to-client stream (a <code className="text-xs">GET</code> with an SSE <code className="text-xs">Accept</code> answers 405; a plain <code className="text-xs">GET</code> returns this description).</dd>
            <dt className="text-slate-500">Protocol versions</dt><dd className="font-mono text-xs">{d.supportedProtocolVersions.join(", ")}</dd>
            <dt className="text-slate-500">Authentication</dt>
            <dd>
              {gated
                ? <>HTTP Basic with an Underwriting Desktop login, sent as an <code className="text-xs">Authorization</code> header on every request. You are signed in as <strong>{actor}</strong>; tool calls run and are audited as that user.</>
                : <>None on this instance (the password gate is off locally); calls run as <strong>{actor}</strong>. The deployed app requires an Underwriting Desktop login via HTTP Basic, sent as an <code className="text-xs">Authorization</code> header on every request.</>}
              <span className="block text-xs text-slate-500">In production this would be OAuth as the MCP authorization spec describes; the demo reuses the underwriter logins so every tool call is traceable to a person.</span>
            </dd>
            <dt className="text-slate-500">Methods</dt><dd className="font-mono text-xs">initialize · ping · tools/list · tools/call · resources/list · resources/read · resources/templates/list · prompts/list</dd>
          </dl>
        </Card>

        <Card title="Connect a client">
          <div className="space-y-4">
            <div>
              <p className="font-medium">Claude Code</p>
              <Code>{`claude mcp add --transport http uwdesk-gl "${endpoint}"${headerFlag}\n\n# then, in a Claude Code session:\n#   "How much premium did we write this month, and which journals make it up?"`}</Code>
            </div>
            <div>
              <p className="font-medium">Claude Desktop, Cursor and other stdio clients (via mcp-remote)</p>
              <Code>{JSON.stringify({ mcpServers: { "uwdesk-gl": gated
                ? { command: "npx", args: ["-y", "mcp-remote", endpoint, "--header", "Authorization:${AUTH_HEADER}"], env: { AUTH_HEADER: "Basic <base64 of underwriter1:PASSWORD>" } }
                : { command: "npx", args: ["-y", "mcp-remote", endpoint] } } }, null, 2)}</Code>
            </div>
            <div>
              <p className="font-medium">MCP Inspector</p>
              <Code>{`npx @modelcontextprotocol/inspector\n# Transport: Streamable HTTP · URL: ${endpoint}${gated ? "\n# Authentication → header name: Authorization · value: Basic <base64 of underwriter1:PASSWORD>" : ""}`}</Code>
            </div>
            <div>
              <p className="font-medium">Raw JSON-RPC with curl</p>
              <Code title="1 · initialize">{rpcExample({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "1" } } })}</Code>
              <Code title="2 · tools/list">{rpcExample({ jsonrpc: "2.0", id: 2, method: "tools/list" })}</Code>
              <Code title="3 · tools/call">{rpcExample({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gl_summary", arguments: { period: "ytd" } } })}</Code>
            </div>
          </div>
        </Card>

        <Card title="Live session" action={<span className="text-slate-500">from this browser</span>}>
          <McpConsole endpoint="/api/mcp" tools={d.tools} firstJournal={firstJournal} />
        </Card>

        <Card title="Server card: initialize result">
          <p className="text-xs text-slate-500">What a client learns from <code>initialize</code>: the server, its capabilities and the instructions it gives the model.</p>
          <Json value={{ protocolVersion: d.protocolVersion, serverInfo: d.serverInfo, capabilities: d.capabilities, instructions: d.instructions }} />
        </Card>

        <Card title={`Tools (${d.tools.length})`}>
          <div className="space-y-4">
            {d.tools.map((t) => (
              <section key={t.name} id={t.name} className="rounded-md border border-slate-200">
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                  <code className="text-sm font-semibold">{t.name}</code>
                  <span className="text-sm text-slate-600">{t.title}</span>
                  <span className="ml-auto flex gap-1">
                    {t.annotations?.readOnlyHint ? <Pill tone="emerald">read-only</Pill> : <Pill tone="amber">writes</Pill>}
                    {t.annotations?.idempotentHint === false && <Pill tone="amber">not idempotent</Pill>}
                  </span>
                </div>
                <div className="space-y-2 px-3 py-3">
                  <p className="text-slate-700">{t.description}</p>
                  <details>
                    <summary className="cursor-pointer text-xs text-slate-500">inputSchema and an example call</summary>
                    <Json title="inputSchema" value={t.inputSchema} />
                    <Json title="tools/call" value={{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: t.name, arguments: t.name === "gl_journal" ? { journal_no: firstJournal } : t.name === "gl_push" ? { period: "this_month", format: "xlsx" } : (t.inputSchema.required?.length || Object.keys(t.inputSchema.properties).length) ? { period: "ytd" } : {} } }} />
                  </details>
                </div>
              </section>
            ))}
          </div>
        </Card>

        <Card title={`Resources (${d.resources.length})`}>
          <table className="w-full text-xs">
            <thead className="text-left text-slate-500"><tr><th className="py-1 pr-3 font-medium">URI</th><th className="py-1 pr-3 font-medium">Name</th><th className="py-1 pr-3 font-medium">Type</th><th className="py-1 font-medium">Description</th></tr></thead>
            <tbody>
              {d.resources.map((r) => (
                <tr key={r.uri} className="border-t border-slate-100 align-top">
                  <td className="py-1 pr-3 font-mono">{r.uri}</td><td className="py-1 pr-3">{r.title ?? r.name}</td><td className="py-1 pr-3 text-slate-500">{r.mimeType}</td><td className="py-1 text-slate-700">{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">Read one with <code>resources/read</code> and its URI. Prompts: none.</p>
        </Card>
      </div>
    </main>
  );
}
