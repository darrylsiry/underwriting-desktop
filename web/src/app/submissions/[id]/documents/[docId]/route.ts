import { contentDisposition } from "@/lib/http";
import { getDocument } from "@/lib/submissions";

export const dynamic = "force-dynamic";

/** Serve an uploaded document: PDFs open inline in the browser, other types download. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;
  const doc = await getDocument(id, docId);
  if (!doc) return new Response("Not found", { status: 404 });
  const inline = doc.content_type === "application/pdf" || doc.filename.toLowerCase().endsWith(".pdf");
  return new Response(new Uint8Array(doc.content), {
    headers: {
      "Content-Type": inline ? "application/pdf" : doc.content_type,
      "Content-Disposition": contentDisposition(doc.filename, inline ? "inline" : "attachment"),
    },
  });
}
