// The AI assistant: a question about anything in the app, answered by Claude with the app's own
// read-only tools (lib/assistant-tools.ts) and linked to the records it used. A manual tool-use
// loop over the Messages API; the HTTP route streams the loop's events to the page as they happen.
import Anthropic from "@anthropic-ai/sdk";
// Types only: the app tools pull in the databases, so they are loaded on demand (tests inject their own).
import type { AppTool, AssistantContext } from "./assistant-tools";

export const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL ?? "claude-opus-5-5";
const MAX_STEPS = 12;
const MAX_TOKENS = 16_000;
const CLAUDE_CALL_TIMEOUT_MS = 120_000;
const QUESTION_DEADLINE_MS = 240_000;   // one whole question; inside the ask route's maxDuration of 300 s

// The Claude Code cloud sandbox reserves ANTHROPIC_API_KEY; there the key is UW_ANTHROPIC_API_KEY (as in ingestion).
const apiKey = () => process.env.UW_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
export const assistantEnabled = () => Boolean(apiKey());

export type Turn = { role: "user" | "assistant"; text: string };

export type AssistantEvent =
  | { type: "status"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ms: number; ok: boolean; chars: number }
  | { type: "answer"; markdown: string; model: string; steps: number; usage: { input: number; output: number; cache_read: number } }
  | { type: "error"; message: string };

export const SYSTEM_PROMPT = `You are the AI assistant built into Underwriting Desktop, an E&S contractors general liability underwriting workstation. You answer questions about anything in the app by calling its tools, and you never guess at data. You see everything regardless of who is asking: everyone here is an admin. You are read-only: you cannot rate, quote, bind, clear a referral, start a renewal or push to the GL; when asked to, explain how to do it in the app and link the page where it happens.

How the app fits together:
- Brokers' submissions arrive in the inbox (/submissions) and are extracted into a submission (SUB-0012) -> intake review (/submissions/<id>) -> accepted -> the underwriting workbench (/submissions/<id>/workbench): rating inputs, schedule credits and debits with written reasons, a rating from the rating service on the active rate version, and referral rules that must be cleared with a note before quoting.
- Quote: Q-2026-0004 v1, v2 ... (/quotes/<id>, with a PDF; a renewal quote also has a memo). Bind -> policy GL-26-00020 with binder BND-26-00020 (/policies/<id>, binder and policy PDFs, subjectivities) -> a balanced journal (JE-000020) in the premium sub-ledger (/accounting), pushed to the general ledger in batches (GLX-20261030-001). Written premium is booked in full at bind; no cash or earning.
- Renewals: a policy up for renewal (prior-system policies GL-25-7xxxx live at /policies/book/<id>; UW Desktop policies at /policies/<id>) gets a renewal submission; its comparison page (/submissions/<id>/renewal) shows expiring vs renewing terms and splits the premium change into terms vs rates.
- The desk (/) shows one underwriter's book, renewals due and next-up tasks; /book lists the in-force book (prior system + UW Desktop); /audit is the audit trail across the desktop, the rating engine and the rate tables; rate versions live at /admin.
- Underwriters are logins like underwriter1 ... underwriter9. A submission belongs to the underwriter who picked it up (clicked Extract on it); a submission still in the inbox belongs to nobody yet, so it is work for whoever asks. "My desk" is a person's own files plus the shared inbox.

The workflow, in the order work is done: 1) extract a broker submission from the inbox (/submissions); 2) review the intake and accept it; 3) rate it on the workbench; 4) clear any referral with a note; 5) issue the quote; 6) bind when the broker orders (quotes expire 30 days after issue; chase before then); 7) collect open subjectivities; 8) for policies coming up to expiry, start the renewal, re-rate, compare and quote. "What should I work on next" means walking that queue: overdue and nearly-due items first, then files that are one step from money (ready to quote, quote awaiting bind), then new inbox submissions, oldest first. An empty personal queue never means nothing to do while the inbox has submissions in it.

How to answer:
- Use the tools. For "what should I do / what's next / what's waiting / what's overdue" call work_queue (for the asker, or for everyone when they ask about the team) and recommend a concrete next action with its link. Start with search_app when a question names a company or an identifier. book_summary for portfolio "how much / how many" questions; gl_summary and gl_journals for anything booked to the GL; get_submission or get_quote to explain a price or what is holding a file up; audit_search for who/when questions; renewals_due for what is coming up; list_* for lists.
- Link every record you mention, using the url fields the tools return, as a markdown link on the identifier or name: [GL-26-00020](/policies/<id>), [Red Rock Electric Group LLC](/insureds/<id>), [SUB-0012](/submissions/<id>). In a table, link the identifier column. Never invent a URL; if a tool returned none, don't link.
- Lead with the answer, then the supporting numbers. Use a markdown table for lists of more than three items. Money as $12,345 (cents only when they matter). Dates as 2026-11-09.
- Say which definition or filter you used when it matters ("in force as of today", "posting dates in October", "underwriter1's desk"). If a question is ambiguous, take the most useful reading and say so in a clause.
- If the data doesn't contain the answer, say so plainly rather than speculating. Keep answers compact.`;

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type Create = (params: CreateParams, options: { signal: AbortSignal }) => Promise<Anthropic.Beta.Messages.BetaMessage>;

let client: Anthropic | null = null;
const defaultCreate: Create = (params, options) =>
  (client ??= new Anthropic({ apiKey: apiKey(), timeout: CLAUDE_CALL_TIMEOUT_MS, maxRetries: 1 })).beta.messages.create(params, options);

/** The work's answer, or a rejection as soon as `signal` aborts, whether or not the work itself notices. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Answer one question, yielding what happens on the way (each tool call and its result) and the
 * final answer. `history` is the earlier turns of this conversation as text; the model re-queries
 * the tools for follow-ups, so answers always rest on current data. `signal` is the asker leaving
 * (Stop, or the page closed); `deadlineMs` bounds the whole question, so a stalled call can't lock
 * the chat (CR-129).
 */
export async function* askAssistant(
  question: string, history: Turn[], ctx: AssistantContext,
  deps: { create?: Create; tools?: AppTool[]; model?: string; signal?: AbortSignal; deadlineMs?: number } = {},
): AsyncGenerator<AssistantEvent> {
  const create = deps.create ?? defaultCreate;
  const tools = deps.tools ?? (await import("./assistant-tools")).APP_TOOLS;
  const model = deps.model ?? ASSISTANT_MODEL;
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    ...history.slice(-12).map((t) => ({ role: t.role, content: t.text })),
    { role: "user", content: `Context: today is ${ctx.today}; the person asking is signed in as ${ctx.actor}.\n\n${question}` },
  ];
  const deadlineMs = deps.deadlineMs ?? QUESTION_DEADLINE_MS;
  const signal = AbortSignal.any([AbortSignal.timeout(deadlineMs), ...(deps.signal ? [deps.signal] : [])]);
  const failure = (err: unknown) => (!signal.aborted ? describeApiError(err)
    : deps.signal?.aborted ? "Stopped."
    : `Stopped after ${Math.round(deadlineMs / 1000)} seconds without an answer; try again, or ask a narrower question.`);
  const usage = { input: 0, output: 0, cache_read: 0 };
  let steps = 0;
  yield { type: "status", text: `Asking ${model}` };

  for (let step = 1; step <= MAX_STEPS; step++) {
    steps = step;
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await untilAborted(create({
        model, max_tokens: MAX_TOKENS,
        // Opus 5.5 thinks adaptively on its own; effort sets how hard. A safety decline falls back
        // server-side to Anthropic's recommended model instead of ending the answer.
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: toolDefinitions(tools), messages,
      } as CreateParams, { signal }), signal);
    } catch (err) {
      yield { type: "error", message: failure(err) };
      return;
    }
    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    usage.cache_read += res.usage.cache_read_input_tokens ?? 0;

    if (res.stop_reason === "refusal") {
      yield { type: "error", message: "The model declined to answer this one." };
      return;
    }
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    const toolUses = res.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !toolUses.length) {
      const text = res.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      yield { type: "answer", markdown: text + (res.stop_reason === "max_tokens" ? "\n\n_(The answer was cut off at the length limit.)_" : ""), model: res.model, steps, usage };
      return;
    }

    messages.push({ role: "assistant", content: res.content });
    for (const t of toolUses) yield { type: "tool", id: t.id, name: t.name, input: t.input };
    let results;
    try {
      results = await untilAborted(Promise.all(toolUses.map(async (t) => {
        const t0 = Date.now();
        const r = await runTool(tools, t.name, t.input, ctx);
        return { t, r, ms: Date.now() - t0 };
      })), signal);
    } catch (err) {
      yield { type: "error", message: failure(err) };
      return;
    }
    for (const { t, r, ms } of results) yield { type: "tool_result", id: t.id, name: t.name, ms, ok: !r.isError, chars: r.content.length };
    messages.push({
      role: "user",
      content: results.map(({ t, r }): Anthropic.Beta.Messages.BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: t.id, content: r.content, is_error: r.isError })),
    });
  }
  yield { type: "error", message: `Stopped after ${MAX_STEPS} rounds of tool calls without a final answer; try a narrower question.` };
}

/** The tool list as the Messages API takes it. */
export const toolDefinitions = (tools: AppTool[]): Anthropic.Tool[] => tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

const MAX_RESULT_CHARS = 60_000;

/** Run one tool and return what goes back to the model (JSON; errors as text with is_error). */
export async function runTool(tools: AppTool[], name: string, input: unknown, ctx: AssistantContext): Promise<{ content: string; isError: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { content: `Unknown tool ${name}`, isError: true };
  try {
    const result = await tool.run((input && typeof input === "object" ? input : {}) as Record<string, unknown>, ctx);
    let content = JSON.stringify(result);
    if (content.length > MAX_RESULT_CHARS) content = content.slice(0, MAX_RESULT_CHARS) + `\n…[truncated at ${MAX_RESULT_CHARS} characters; ask for a smaller slice]`;
    return { content, isError: typeof result === "object" && result !== null && "error" in result };
  } catch (err) {
    return { content: `Tool failed: ${(err as Error).message}`, isError: true };
  }
}

function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Claude API rejected the API key (ANTHROPIC_API_KEY).";
  if (err instanceof Anthropic.RateLimitError) return "The Claude API is rate-limiting requests; try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`;
  return (err as Error).message;
}
