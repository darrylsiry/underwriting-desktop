import { revalidatePath } from "next/cache";
import { inboxFiles, listInbox } from "@/lib/inbox";
import { INGESTION_SERVICE_URL } from "@/lib/services";
import { filesForm, storeSubmission } from "@/lib/submissions";
import type { Extraction } from "@/lib/submission";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

/**
 * Extract one drop-folder submission and stream what's happening as newline-delimited JSON, for the
 * live activity panel: the ingestion service's events (steps, fields, losses, Claude's reasoning)
 * are relayed as they arrive, then the submission is stored and a final `stored` event names it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ folder: string }> }) {
  const { folder } = await params;
  const actor = await currentUser();
  const started = Date.now();
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>, t = (Date.now() - started) / 1000) =>
        controller.enqueue(encoder.encode(JSON.stringify({ ...event, t: Math.round(t * 100) / 100 }) + "\n"));
      try {
        // Checked first so a second click or stale tab doesn't spend a Claude call; the unique index is the backstop.
        if (!(await listInbox()).some((f) => f.folder === folder)) {
          throw new Error(`${folder} was already picked up or is no longer in the inbox. Refresh the page.`);
        }
        const files = inboxFiles(folder);
        send({ type: "step", stage: "pickup", message: `${actor} picked up ${folder} from the broker drop folder (${files.length} document(s))` });
        send({ type: "step", stage: "send", message: `Sending to the ingestion service (${new URL(INGESTION_SERVICE_URL).host})` });

        const res = await fetch(`${INGESTION_SERVICE_URL}/extract/stream`, {
          method: "POST", body: filesForm(files),
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]),
        });
        if (!res.ok || !res.body) throw new Error(`Ingestion service returned ${res.status}: ${await res.text()}`);
        const offset = (Date.now() - started) / 1000;

        let extraction: Extraction | null = null;
        let buffer = "";
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          buffer += decoder.decode(r.value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.type === "result") extraction = event.result;
            else if (event.type === "error") throw new Error(event.message);
            else send(event, offset + (event.t ?? 0));
          }
        }
        if (!extraction) throw new Error("The ingestion service ended without a result");

        const { id, reference } = await storeSubmission(files, extraction, actor, folder);
        revalidatePath("/submissions");
        send({ type: "stored", id, reference, message: `Saved as ${reference}; opening intake review` });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
