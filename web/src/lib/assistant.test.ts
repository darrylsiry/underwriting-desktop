import assert from "node:assert/strict";
import { test } from "node:test";
import { askAssistant, type AssistantEvent, type Create } from "./assistant.ts";
import type { AppTool } from "./assistant-tools.ts";

const ctx = { actor: "underwriter1", origin: "https://example.test", today: "2026-10-30" };
const tools: AppTool[] = [{
  name: "book_summary", description: "numbers", input_schema: { type: "object", properties: {} },
  run: async (input) => ({ in_force_premium: 1_277_416, policies: 21, scope: input.underwriter ?? "everyone", urls: { book: "/book" } }),
}];

const message = (over: Record<string, unknown>) => ({
  id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null, stop_details: null, container: null, context_management: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null, service_tier: null, cache_creation: null, inference_geo: null, iterations: null, speed: null },
  ...over,
}) as unknown as Awaited<ReturnType<Create>>;

async function collect(create: Create) {
  const events: AssistantEvent[] = [];
  for await (const e of askAssistant("How big is the book?", [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }], ctx, { create, tools, model: "claude-opus-5-5" })) events.push(e);
  return events;
}

test("a tool round-trip: the tool runs, its result goes back, the answer is the final text", async () => {
  const calls: Parameters<Create>[0][] = [];
  const create: Create = async (params) => {
    calls.push(params);
    if (calls.length === 1) return message({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "book_summary", input: { underwriter: "underwriter1" } }] });
    return message({ stop_reason: "end_turn", content: [{ type: "text", text: "The book is **$1,277,416** across [21 policies](/book)." }], usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 250 } });
  };
  const events = await collect(create);
  assert.deepEqual(events.map((e) => e.type), ["status", "tool", "tool_result", "answer"]);
  const answer = events[3] as Extract<AssistantEvent, { type: "answer" }>;
  assert.match(answer.markdown, /\[21 policies\]\(\/book\)/);
  assert.equal(answer.steps, 2);
  assert.deepEqual(answer.usage, { input: 400, output: 60, cache_read: 250 });

  // the second request carries the history, the question with its context line, the tool call and its result
  const second = calls[1];
  assert.equal(second.messages.length, 5);
  assert.match(String(second.messages[2].content), /today is 2026-10-30; the person asking is signed in as underwriter1/);
  const result = (second.messages[4].content as { type: string; tool_use_id: string; content: string; is_error: boolean }[])[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.tool_use_id, "tu_1");
  assert.equal(JSON.parse(result.content).scope, "underwriter1");
  assert.equal(result.is_error, false);
  assert.equal(second.tools?.length, 1);
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal((second as unknown as { fallbacks: string }).fallbacks, "default");
});

test("an unknown tool and a refusal are reported, not thrown", async () => {
  let n = 0;
  const create: Create = async () => (++n === 1
    ? message({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_9", name: "nope", input: {} }] })
    : message({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }));
  const events = await collect(create);
  const tr = events.find((e) => e.type === "tool_result") as Extract<AssistantEvent, { type: "tool_result" }>;
  assert.equal(tr.ok, false);

  const refusing: Create = async () => message({ stop_reason: "refusal", content: [] });
  const r = await collect(refusing);
  assert.equal(r.at(-1)?.type, "error");
});
