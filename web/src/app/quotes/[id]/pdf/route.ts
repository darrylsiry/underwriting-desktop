import { contentDisposition } from "@/lib/http";
import { getQuotePdf } from "@/lib/quotes";

export const dynamic = "force-dynamic";

/** The quote PDF exactly as issued (stored with the quote, never regenerated). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = await getQuotePdf(id);
  if (!q) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(q.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition(`${q.quote_number}-v${q.version}.pdf`, "inline"),
    },
  });
}
