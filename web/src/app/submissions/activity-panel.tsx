"use client";

import { moneyExact } from "@/lib/format";
import { useEffect, useRef, useState } from "react";
import { FIELD_DEFS } from "@/lib/submission";

// Live view of one extraction: every step, field and loss as the ingestion service reports it,
// plus Claude's reasoning summary while it reads. Built for demos, so it says what's happening.

export type ActivityEvent = {
  type: "step" | "field" | "loss" | "thinking" | "warning" | "stored" | "error";
  t: number;
  stage?: string;
  message?: string;
  path?: string;
  value?: unknown;
  basis?: string;
  confidence?: number;
  method?: string;
  date?: string;
  description?: string;
  incurred?: number;
  status?: string;
  text?: string;
  id?: string;
  reference?: string;
};

const LABELS = Object.fromEntries(FIELD_DEFS.map((d) => [d.path, d.label]));
const TYPES = Object.fromEntries(FIELD_DEFS.map((d) => [d.path, d.type]));
const STAGES: Record<string, string> = {
  pickup: "Inbox", send: "Send", classes: "Rating", receive: "Receive", classify: "Classify",
  form: "Form", claude: "Claude", merge: "Merge",
};

/** Money gets thousands separators; ZIPs, class codes and years stay as written. */
const fmtValue = (path: string | undefined, v: unknown) => {
  const s = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  return TYPES[path ?? ""] === "money" && /^\d+$/.test(s) ? moneyExact(s) : s;
};

function confidenceClass(c: number) {
  return c >= 0.9 ? "text-emerald-400" : c >= 0.7 ? "text-amber-300" : "text-rose-400";
}

/** Merge consecutive thinking deltas into one growing entry, so reasoning reads as prose. */
export function appendEvent(events: ActivityEvent[], e: ActivityEvent): ActivityEvent[] {
  const last = events[events.length - 1];
  if (e.type === "thinking" && last?.type === "thinking") {
    return [...events.slice(0, -1), { ...last, text: (last.text ?? "") + (e.text ?? "") }];
  }
  return [...events, e];
}

function Row({ e }: { e: ActivityEvent }) {
  const time = <span className="w-14 shrink-0 text-right tabular-nums text-slate-500">+{e.t.toFixed(1)}s</span>;
  switch (e.type) {
    case "field":
      return (
        <div className="flex gap-3">
          {time}
          <span className={`w-14 shrink-0 ${e.method === "form_field" ? "text-sky-400" : "text-violet-400"}`}>
            {e.method === "form_field" ? "form" : "claude"}
          </span>
          <span className="w-44 shrink-0 truncate text-slate-400" title={e.path}>{LABELS[e.path ?? ""] ?? e.path}</span>
          <span className="min-w-0 flex-1 truncate text-slate-100" title={String(e.value)}>{fmtValue(e.path, e.value)}</span>
          <span className={`shrink-0 tabular-nums ${confidenceClass(e.confidence ?? 0)}`}>
            {Math.round((e.confidence ?? 0) * 100)}%{e.basis === "inferred" && <span className="text-slate-500"> inferred</span>}
          </span>
        </div>
      );
    case "loss":
      return (
        <div className="flex gap-3">
          {time}
          <span className="w-14 shrink-0 text-orange-300">loss</span>
          <span className="min-w-0 flex-1 truncate text-slate-200">
            {e.date} · ${Number(e.incurred).toLocaleString("en-US")} · {e.status} · <span className="text-slate-400">{e.description}</span>
          </span>
        </div>
      );
    case "thinking":
      return (
        <div className="flex gap-3">
          {time}
          <span className="w-14 shrink-0 text-violet-400">thinks</span>
          <p className="min-w-0 flex-1 whitespace-pre-wrap italic text-violet-200/90">{e.text?.trim()}</p>
        </div>
      );
    case "warning":
      return <div className="flex gap-3">{time}<span className="w-14 shrink-0 text-amber-400">warn</span><span className="flex-1 text-amber-200">{e.message}</span></div>;
    case "error":
      return <div className="flex gap-3">{time}<span className="w-14 shrink-0 text-rose-400">error</span><span className="flex-1 text-rose-300">{e.message}</span></div>;
    case "stored":
      return <div className="flex gap-3">{time}<span className="w-14 shrink-0 text-emerald-400">done</span><span className="flex-1 font-semibold text-emerald-300">{e.message}</span></div>;
    default:
      return (
        <div className="flex gap-3">
          {time}
          <span className="w-14 shrink-0 font-semibold uppercase tracking-wide text-slate-400">{STAGES[e.stage ?? ""] ?? e.stage}</span>
          <span className="flex-1 text-slate-100">{e.message}</span>
        </div>
      );
  }
}

export function ActivityPanel({ title, events, running, onClose, onRetry }: {
  title: string; events: ActivityEvent[]; running: boolean; onClose: () => void; onRetry?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [startedAt] = useState(Date.now());
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events]);

  const last = events[events.length - 1];
  const elapsed = running ? (now - startedAt) / 1000 : last?.t ?? 0;
  const fields = events.filter((e) => e.type === "field");
  const formCount = fields.filter((e) => e.method === "form_field").length;
  const claudeStage = events.some((e) => e.stage === "claude");
  const failure = events.find((e) => e.type === "error");
  const failed = !!failure;
  const done = events.find((e) => e.type === "stored");
  // A quiet spell while Claude works (it reads and reasons before it writes): say so instead of looking stuck.
  const waitingOnClaude = running && claudeStage && last && elapsed - last.t > 1.5;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-label={`Ingesting ${title}`}>
      <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-slate-950 shadow-2xl ring-1 ring-slate-800">
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span className={`h-2.5 w-2.5 rounded-full ${failed ? "bg-rose-500" : done ? "bg-emerald-500" : "animate-pulse bg-indigo-400"}`} />
          <h2 className="font-semibold text-white">Ingesting {title}</h2>
          <span className="ml-auto font-mono text-sm tabular-nums text-slate-400">{elapsed.toFixed(1)}s</span>
        </div>
        <div className="flex gap-6 border-b border-slate-800 px-5 py-2 font-mono text-xs text-slate-400">
          <span><span className="text-slate-100">{fields.length}</span> fields</span>
          <span><span className="text-sky-400">{formCount}</span> from form fields</span>
          <span><span className="text-violet-400">{fields.length - formCount}</span> from Claude</span>
          <span><span className="text-orange-300">{events.filter((e) => e.type === "loss").length}</span> losses</span>
        </div>
        <div ref={logRef} className="flex-1 space-y-1.5 overflow-y-auto px-5 py-4 font-mono text-[13px] leading-relaxed">
          {events.map((e, i) => <Row key={i} e={e} />)}
          {running && (
            <div className="flex gap-3 text-slate-500">
              <span className="w-14 shrink-0" />
              <span className="animate-pulse">
                {waitingOnClaude ? "Claude is reading the documents and reasoning about them…" : "working…"}
              </span>
            </div>
          )}
        </div>
        {/* UX-008: what went wrong in plain words, and the way forward. */}
        {failed && !running && (
          <p className="border-t border-slate-800 bg-rose-950/40 px-5 py-3 text-sm text-rose-200" role="alert">{failure.message}</p>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-slate-800 px-5 py-3">
          {failed && !running && onRetry && (
            <button onClick={onRetry} className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">Try again</button>
          )}
          {done?.id && (
            <a href={`/submissions/${done.id}`} className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">
              Open {done.reference} →
            </a>
          )}
          <button onClick={onClose} className="rounded-md border border-slate-700 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
            {running ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
