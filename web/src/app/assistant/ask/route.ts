import { askAssistant, assistantEnabled, type Turn } from "@/lib/assistant";
import { glDate } from "@/lib/gl-journal";
import { CROSS_SITE_REFUSED, requestOrigin, sameOrigin } from "@/lib/http";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Ask the assistant; the answer streams back as newline-delimited JSON events (tool calls as they happen, then the answer). */
export async function POST(req: Request) {
  // Each question is up to a dozen Claude calls in the user's name: only this site's own page may ask (CR-079).
  if (!sameOrigin(req.headers)) return Response.json({ error: CROSS_SITE_REFUSED }, { status: 403 });
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return Response.json({ error: "Send JSON: { question, history }" }, { status: 415 });
  let body: { question?: unknown; history?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "Send JSON: { question, history }" }, { status: 400 }); }
  const question = String(body.question ?? "").trim().slice(0, 4000);
  if (!question) return Response.json({ error: "Ask something" }, { status: 400 });
  const history: Turn[] = Array.isArray(body.history)
    ? (body.history as unknown[]).filter((t): t is Turn => !!t && typeof t === "object" && ((t as Turn).role === "user" || (t as Turn).role === "assistant") && typeof (t as Turn).text === "string")
      .map((t) => ({ role: t.role, text: t.text.slice(0, 12_000) })).slice(-12)
    : [];
  const ctx = { actor: await currentUser(), origin: requestOrigin(req.headers), today: glDate(new Date()) };
  const encoder = new TextEncoder();
  let gone = false;   // the reader left (Stop, or the page closed): nothing more can be sent
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: unknown) => { if (!gone) controller.enqueue(encoder.encode(JSON.stringify(e) + "\n")); };
      try {
        if (!assistantEnabled()) {
          send({ type: "error", message: "The assistant needs ANTHROPIC_API_KEY on the web app (the same key the ingestion service uses)." });
        } else {
          for await (const event of askAssistant(question, history, ctx, { signal: req.signal })) send(event);
        }
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        if (!gone) controller.close();
      }
    },
    cancel() { gone = true; },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
