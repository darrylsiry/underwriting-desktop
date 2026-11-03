import { revalidatePath } from "next/cache";
import { CROSS_SITE_REFUSED, sameOrigin } from "@/lib/http";
import { inboxFiles, listInbox } from "@/lib/inbox";
import { ServiceError, describeServiceError, errorDetailOf } from "@/lib/service-errors";
import { INGESTION_SERVICE_URL } from "@/lib/services";
import { filesForm, storeSubmission } from "@/lib/submissions";
import type { Extraction } from "@/lib/submission";
import { currentUser } from "@/lib/user";

/** A message already written for the reader. `final`: trying again can only fail the same way. */
class Told extends Error {
  final: boolean;
  constructor(message: string, final = false) {
    super(message);
    this.final = final;
  }
}

export const dynamic = "force-dynamic";

/**
 * Extract one drop-folder submission and stream what's happening as newline-delimited JSON, for the
 * live activity panel: the ingestion service's events (steps, fields, losses, Claude's reasoning)
 * are relayed as they arrive, then the submission is stored and a final `stored` event names it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ folder: string }> }) {
  // Spends a Claude call and creates a submission in the user's name: only this site's own page may ask (CR-065).
  if (!sameOrigin(req.headers)) return new Response(CROSS_SITE_REFUSED, { status: 403, headers: { "Content-Type": "text/plain" } });
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
          throw new Told(`${folder} was already picked up or is no longer in the inbox. Refresh the page.`, true);
        }
        const files = inboxFiles(folder);
        send({ type: "step", stage: "pickup", message: `${actor} picked up ${folder} from the broker drop folder (${files.length} document(s))` });
        send({ type: "step", stage: "send", message: `Sending to the ingestion service (${new URL(INGESTION_SERVICE_URL).host})` });

        const res = await fetch(`${INGESTION_SERVICE_URL}/extract/stream`, {
          method: "POST", body: filesForm(files),
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]),
        });
        if (!res.ok) throw new Told(describeServiceError(new ServiceError(res.status, errorDetailOf(await res.text())), "document reader"));
        if (!res.body) throw new Told(describeServiceError(new ServiceError(502), "document reader"));
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
            else if (event.type === "error") throw new Told(event.message);
            else send(event, offset + (event.t ?? 0));
          }
        }
        if (!extraction) throw new Told("The document reader stopped before it finished. Nothing was saved; try again.");

        const { id, reference } = await storeSubmission(files, extraction, actor, folder);
        revalidatePath("/submissions");
        send({ type: "stored", id, reference, message: `Saved as ${reference}; opening intake review` });
      } catch (err) {
        // A service that gives no answer at all throws a raw "fetch failed": say what that means (UX-059).
        send(err instanceof Told ? { type: "error", message: err.message, final: err.final } : { type: "error", message: describeServiceError(err, "document reader") });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
