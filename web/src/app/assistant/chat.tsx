"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import type { AssistantEvent, Turn } from "@/lib/assistant";

type ToolStep = { id: string; name: string; input: unknown; ms?: number; ok?: boolean };
type Message = { role: "user" | "assistant"; text: string; steps: ToolStep[]; error?: string; pending?: boolean; meta?: string };

const describeInput = (input: unknown) => {
  const o = (input ?? {}) as Record<string, unknown>;
  const parts = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length ? parts.join(", ") : "";
};

export function AssistantChat({ user, model, enabled, suggestions }: { user: string; model: string; enabled: boolean; suggestions: string[] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const history: Turn[] = messages.filter((m) => !m.error && !m.pending).map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, { role: "user", text: q, steps: [] }, { role: "assistant", text: "", steps: [], pending: true }]);
    const update = (fn: (m: Message) => Message) => setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 ? fn(m) : m)));
    try {
      const res = await fetch("/assistant/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, history }) });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        buffer += decoder.decode(r.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line) as AssistantEvent;
          if (e.type === "tool") update((m) => ({ ...m, steps: [...m.steps, { id: e.id, name: e.name, input: e.input }] }));
          else if (e.type === "tool_result") update((m) => ({ ...m, steps: m.steps.map((s) => (s.id === e.id ? { ...s, ms: e.ms, ok: e.ok } : s)) }));
          else if (e.type === "answer") update((m) => ({ ...m, text: e.markdown, pending: false, meta: `${e.model} · ${e.steps} round${e.steps === 1 ? "" : "s"} · ${(e.usage.input + e.usage.output).toLocaleString("en-US")} tokens${e.usage.cache_read ? ` (${e.usage.cache_read.toLocaleString("en-US")} cached)` : ""}` }));
          else if (e.type === "error") update((m) => ({ ...m, error: e.message, pending: false }));
        }
      }
      update((m) => (m.pending ? { ...m, pending: false, error: m.error ?? "The connection closed before an answer arrived." } : m));
    } catch (err) {
      update((m) => ({ ...m, error: (err as Error).message, pending: false }));
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!enabled && (
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
          The assistant isn&apos;t configured on this instance: set <code>ANTHROPIC_API_KEY</code> for the web app (the same key the ingestion service uses) and restart it.
        </p>
      )}
      {messages.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-600">
            Ask anything about the book, a submission, a quote, a policy, the GL or the audit trail. Answers come from the app&apos;s own data, with links to the records they rest on, and cover everyone&apos;s work, not only yours.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => void ask(s)} disabled={busy || !enabled} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50">{s}</button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            {m.role === "user" ? (
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2 text-sm text-white whitespace-pre-wrap">{m.text}</div>
            ) : (
              <div className="w-full max-w-[92%] rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-3 shadow-sm">
                {m.steps.length > 0 && (
                  <details className="mb-2" open={m.pending}>
                    <summary className="cursor-pointer text-xs text-slate-500">
                      {m.pending ? "Looking it up" : "Looked at"} · {m.steps.length} tool call{m.steps.length === 1 ? "" : "s"}
                    </summary>
                    <ol className="mt-1 space-y-0.5 text-xs text-slate-500">
                      {m.steps.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-baseline gap-x-2">
                          <code className="font-mono text-[11px] text-slate-700">{s.name}</code>
                          <span className="truncate text-slate-400" title={describeInput(s.input)}>{describeInput(s.input)}</span>
                          <span className="ml-auto whitespace-nowrap">{s.ms === undefined ? "…" : s.ok === false ? `failed · ${s.ms} ms` : `${s.ms} ms`}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {m.pending && !m.text && <p className="text-sm text-slate-400"><span className="inline-block animate-pulse">Thinking…</span></p>}
                {m.text && <Markdown source={m.text} />}
                {m.error && <p className="mt-2 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{m.error}</p>}
                {m.meta && <p className="mt-2 text-[11px] text-slate-400">{m.meta}</p>}
              </div>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <form className="sticky bottom-4 flex items-end gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-md"
        onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        <textarea ref={box} value={input} onChange={(e) => setInput(e.target.value)} rows={2} disabled={!enabled}
          placeholder={`Ask about anything in the app, ${user}… (Enter to send, Shift+Enter for a new line)`}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
          className="flex-1 resize-none rounded-md border-0 px-2 py-1 text-sm text-slate-900 focus:outline-none" />
        <button type="submit" disabled={busy || !enabled || !input.trim()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? "Working…" : "Ask"}</button>
        {messages.length > 0 && <button type="button" onClick={() => setMessages([])} disabled={busy} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">New</button>}
      </form>
      <p className="text-center text-[11px] text-slate-400">Powered by the Claude API ({model}). Read-only: the assistant looks things up and links to them; it never changes anything.</p>
    </div>
  );
}
