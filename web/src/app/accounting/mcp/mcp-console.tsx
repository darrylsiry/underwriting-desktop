"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// A live MCP session from this page to the server, in the browser: the handshake every client
// performs (initialize, initialized, tools/list) followed by a tool call, each shown as the
// JSON-RPC that went over the wire, plus a form to call any tool with arguments of your own.

type Tool = { name: string; title?: string; description: string; inputSchema: unknown };
type Step = { label: string; request: unknown; response: unknown; status: number; ms: number };

const EXAMPLE_ARGS: Record<string, unknown> = {
  gl_summary: { period: "ytd" }, gl_journals: { period: "all" }, gl_journal: { journal_no: "JE-000001" },
  gl_periods: {}, gl_batches: {}, gl_accounts: {}, gl_push: { period: "this_month", format: "xlsx" },
};

export function McpConsole({ endpoint, tools, firstJournal }: { endpoint: string; tools: Tool[]; firstJournal: string }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState(tools[0]?.name ?? "gl_summary");
  const [args, setArgs] = useState(JSON.stringify(EXAMPLE_ARGS[tools[0]?.name ?? "gl_summary"] ?? {}, null, 2));
  const [result, setResult] = useState<Step | null>(null);
  const idRef = useRef(0);

  const rpc = useCallback(async (label: string, method: string, params?: unknown): Promise<Step> => {
    const isNotification = method.startsWith("notifications/");
    const request = isNotification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++idRef.current, method, params };
    const t0 = performance.now();
    const res = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(request),
    });
    const text = await res.text();
    let response: unknown = text ? JSON.parse(text) : null;
    if (res.status === 202) response = "(202 Accepted: notifications get no body)";
    return { label, request, response, status: res.status, ms: Math.round(performance.now() - t0) };
  }, [endpoint]);

  const handshake = useCallback(async () => {
    setRunning(true); setError(null); setSteps([]);
    try {
      const log: Step[] = [];
      const push = (s: Step) => { log.push(s); setSteps([...log]); };
      push(await rpc("1 · initialize", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "accounting-page", version: "1.0" } }));
      push(await rpc("2 · notifications/initialized", "notifications/initialized"));
      push(await rpc("3 · tools/list", "tools/list"));
      push(await rpc("4 · tools/call gl_summary", "tools/call", { name: "gl_summary", arguments: { period: "ytd" } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [rpc]);

  useEffect(() => { void handshake(); }, [handshake]);

  async function call() {
    setError(null); setResult(null);
    let parsed: unknown;
    try { parsed = JSON.parse(args || "{}"); } catch { setError("Arguments must be a JSON object"); return; }
    if (tool === "gl_push" && !window.confirm("gl_push opens a new GL export batch and stamps the lines not pushed before, like the push button. Continue?")) return;
    setRunning(true);
    try { setResult(await rpc(`tools/call ${tool}`, "tools/call", { name: tool, arguments: parsed })); }
    catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  }

  const pickTool = (name: string) => {
    setTool(name);
    const ex = name === "gl_journal" ? { journal_no: firstJournal } : EXAMPLE_ARGS[name] ?? {};
    setArgs(JSON.stringify(ex, null, 2));
    setResult(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void handshake()} disabled={running} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {running ? "Running…" : "Run the handshake again"}
        </button>
        <span className="text-xs text-slate-500">This browser is the MCP client: each step below is the JSON-RPC message it posted to <code>{endpoint}</code> and what came back, with your login attached by the browser.</span>
      </div>
      {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      <ol className="space-y-3">
        {steps.map((s) => <StepView key={s.label} s={s} />)}
      </ol>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <p className="text-sm font-medium">Call a tool</p>
        <div className="mt-2 grid gap-3 md:grid-cols-[14rem_1fr]">
          <label className="flex flex-col gap-1 text-xs text-slate-500">Tool
            <select value={tool} onChange={(e) => pickTool(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm text-slate-900">
              {tools.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            <span className="text-[11px] text-slate-500">{tools.find((t) => t.name === tool)?.description}</span>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">Arguments (JSON)
            <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={4} spellCheck={false} className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-900" />
          </label>
        </div>
        <button type="button" onClick={() => void call()} disabled={running} className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
          Call {tool}
        </button>
        {result && <div className="mt-3"><StepView s={result} /></div>}
      </div>
    </div>
  );
}

function StepView({ s }: { s: Step }) {
  const r = s.response as { result?: { isError?: boolean; structuredContent?: unknown; content?: { text: string }[] }; error?: unknown } | string | null;
  const failed = s.status >= 400 || (typeof r === "object" && r !== null && (r.error !== undefined || r.result?.isError));
  const shown = typeof r === "object" && r !== null && r.result && "structuredContent" in r.result ? { ...r, result: { ...r.result, content: "(text form of structuredContent, omitted here)" } } : r;
  return (
    <li className="rounded-md border border-slate-200">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-xs">
        <span className="font-mono font-semibold">{s.label}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono ${failed ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>HTTP {s.status}</span>
        <span className="text-slate-400">{s.ms} ms</span>
      </div>
      <div className="grid gap-2 p-2 lg:grid-cols-2">
        <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100"><code>{`→ ${JSON.stringify(s.request, null, 2)}`}</code></pre>
        <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-2 text-[11px] leading-relaxed text-emerald-100"><code>{`← ${typeof shown === "string" ? shown : JSON.stringify(shown, null, 2)}`}</code></pre>
      </div>
    </li>
  );
}
