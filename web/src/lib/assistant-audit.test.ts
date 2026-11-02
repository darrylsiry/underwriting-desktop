import assert from "node:assert/strict";
import { test } from "node:test";
import { auditSearch, type AuditSearchDeps } from "./assistant-audit.ts";
import { fromDesktop } from "./timeline-merge.ts";

type Loaded = Awaited<ReturnType<AuditSearchDeps["loadTimeline"]>>;

const event = (id: number, at: string) => fromDesktop({
  id, occurred_at: new Date(at), actor: "pat", action: "quote.issued", entity_type: "quote", entity_id: `q${id}`,
  summary: `Event ${id}`, before: null, after: null, correlation_id: "c",
});

const timeline = (over: Partial<Loaded> = {}): Loaded => ({
  events: [], labels: new Map(), warnings: [], scope: null, capped: false, cappedBy: [], olderCursor: null, ...over,
});

function deps(result: Loaded, known: Record<string, string> = {}) {
  const calls: { id: string | undefined; range: { from?: string; to?: string } }[] = [];
  const d: AuditSearchDeps = {
    submissionIdFor: async (ref) => known[ref] ?? null,
    loadTimeline: async (id, range) => { calls.push({ id, range }); return result; },
  };
  return { d, calls };
}

test("a reference that doesn't exist is a failed lookup, not the global timeline (CR-092)", async () => {
  const { d, calls } = deps(timeline({ events: [event(1, "2026-01-05T12:00:00Z")] }));
  const r = await auditSearch({ submission_id: "SUB-9999" }, d);
  assert.match((r as { error: string }).error, /No submission SUB-9999/);
  assert.equal(calls.length, 0);
});

test("an id that loads no submission is a failed lookup too (CR-092)", async () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const { d } = deps(timeline({ warnings: ["Submission not found"] }), { [id]: id });
  assert.match(((await auditSearch({ submission_id: id }, d)) as { error: string }).error, /No submission/);
});

test("the dates go to the query, so January is findable (CR-103)", async () => {
  const { d, calls } = deps(timeline({ events: [event(1, "2026-01-15T17:00:00Z"), event(2, "2026-10-15T16:00:00Z")] }));
  const r = await auditSearch({ from: "2026-01-01", to: "2026-01-31" }, d) as { count: number; events: { summary: string }[]; capped: boolean; note?: string };
  assert.deepEqual(calls, [{ id: undefined, range: { from: "2026-01-01", to: "2026-01-31" } }]);
  assert.deepEqual(r.events.map((e) => e.summary), ["Event 1"]);
  assert.equal(r.capped, false);
  assert.equal(r.note, undefined);
});

test("a cut history says so, and names what cut it (CR-103)", async () => {
  const { d } = deps(timeline({ capped: true, cappedBy: ["Rating engine"], olderCursor: "2026-06-01T00:00:00.000Z" }));
  const r = await auditSearch({}, d) as { capped: boolean; capped_sources: string[]; oldest_loaded_at: string; note: string };
  assert.equal(r.capped, true);
  assert.deepEqual(r.capped_sources, ["Rating engine"]);
  assert.equal(r.oldest_loaded_at, "2026-06-01T00:00:00.000Z");
  assert.match(r.note, /Rating engine.*nothing before 2026-06-01/);
});

test("a date that isn't on the calendar comes back to the model to correct (CR-068)", async () => {
  const { d, calls } = deps(timeline());
  assert.match(((await auditSearch({ from: "2026-02-30" }, d)) as { error: string }).error, /2026-02-30 is not a date/);
  assert.equal(calls.length, 0);
});

test("the limit cuts the list but not the count of what matched", async () => {
  const { d } = deps(timeline({ events: [event(1, "2026-01-15T17:00:00Z"), event(2, "2026-01-16T17:00:00Z")] }));
  const r = await auditSearch({ limit: 1 }, d) as { count: number; total_matching: number };
  assert.equal(r.count, 1);
  assert.equal(r.total_matching, 2);
});
