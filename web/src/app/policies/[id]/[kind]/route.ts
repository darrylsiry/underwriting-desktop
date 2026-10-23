import { getPolicyDocument } from "@/lib/policies";

export const dynamic = "force-dynamic";

/** The binder or policy PDF exactly as issued at binding. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  if (kind !== "binder" && kind !== "policy") return new Response("Not found", { status: 404 });
  const doc = await getPolicyDocument(id, kind);
  if (!doc) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(doc.pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${doc.filename}"` },
  });
}
