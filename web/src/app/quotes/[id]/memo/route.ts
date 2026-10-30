import { contentDisposition } from "@/lib/http";
import { getQuoteMemo } from "@/lib/quotes";

export const dynamic = "force-dynamic";

/** The renewal memo issued with a renewal quote, as stored (never regenerated). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await getQuoteMemo(id);
  if (!m) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(m.pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": contentDisposition(`${m.quote_number}-v${m.version}-renewal-memo.pdf`, "inline") },
  });
}
