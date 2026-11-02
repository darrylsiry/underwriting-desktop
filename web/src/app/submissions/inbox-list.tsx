"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { InboxFolder } from "@/lib/inbox-files";
import { ServiceError, describeServiceError, errorDetailOf } from "@/lib/service-errors";
import { ActivityPanel, appendEvent, type ActivityEvent } from "./activity-panel";

const KIND: Record<string, string> = {
  "application/pdf": "PDF",
  "message/rfc822": "Email",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "text/plain": "Text",
};

/** Seconds the finished activity log stays up before intake review opens, so a demo audience can read it. */
const SHOW_DONE_FOR_MS = 2500;

export function InboxList({ items }: { items: InboxFolder[] }) {
  const router = useRouter();
  const [active, setActive] = useState<InboxFolder | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const abort = useRef<AbortController | null>(null);

  async function extract(item: InboxFolder) {
    const controller = new AbortController();
    abort.current = controller;
    setActive(item);
    setAttempt((n) => n + 1);
    setEvents([]);
    setRunning(true);
    try {
      const res = await fetch(`/submissions/inbox/${encodeURIComponent(item.folder)}/extract`, {
        method: "POST", signal: controller.signal,
      });
      // UX-008: the status and the service's own words, turned into a sentence below.
      if (!res.ok) throw new ServiceError(res.status, errorDetailOf(await res.text()));
      if (!res.body) throw new ServiceError(502, null);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        buffer += decoder.decode(r.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event: ActivityEvent = JSON.parse(line);
          setEvents((prev) => appendEvent(prev, event));
          if (event.type === "stored" && event.id) {
            const id = event.id;
            setTimeout(() => { if (!controller.signal.aborted) router.push(`/submissions/${id}`); }, SHOW_DONE_FOR_MS);
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setEvents((prev) => [...prev, { type: "error", t: prev.at(-1)?.t ?? 0, message: describeServiceError(err, "document reader") }]);   // UX-008
      }
    } finally {
      setRunning(false);
    }
  }

  function close() {
    abort.current?.abort();
    setActive(null);
    router.refresh();
  }

  return (
    <>
      <ul className="divide-y divide-slate-100">
        {items.map((item) => (
          <li key={item.folder} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{item.title}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {item.files.map((f) => (
                  <span key={f.name} title={`${f.name} · ${(f.size / 1024).toFixed(0)} KB`}
                    className="inline-flex max-w-full items-center gap-1 truncate rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                    <span className="font-semibold text-slate-500">{KIND[f.contentType] ?? "File"}</span>{f.name}
                  </span>
                ))}
              </div>
            </div>
            <span className="font-mono text-xs text-slate-500">{item.folder}</span>
            <button onClick={() => extract(item)} disabled={running}
              className="whitespace-nowrap rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-60">
              Extract →
            </button>
          </li>
        ))}
      </ul>
      {/* A new key per attempt: "Try again" gets a new panel, and its clock starts from zero (CR-145). */}
      {active && <ActivityPanel key={attempt} title={active.title} events={events} running={running} onClose={close} onRetry={() => extract(active)} />}
    </>
  );
}
