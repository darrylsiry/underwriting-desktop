import { EXPORT_FORMATS, glDate, type ExportFormat } from "@/lib/gl-journal";
import { parseLedgerQuery } from "@/lib/gl-query";
import { ledgerFilter } from "@/lib/gl-service";
import { CROSS_SITE_REFUSED, contentDisposition, requestOrigin, sameOrigin } from "@/lib/http";
import { exportLedger } from "@/lib/ledger";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

/** Push the filtered sub-ledger to the GL: a POST from the Accounting page that downloads the file and marks the lines. */
export async function POST(req: Request) {
  // Stamps ledger lines with a batch in the user's name: only this site's own page may ask (CR-065).
  if (!sameOrigin(req.headers)) return new Response(CROSS_SITE_REFUSED, { status: 403, headers: { "Content-Type": "text/plain" } });
  const form = await req.formData();
  const p = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const { query } = parseLedgerQuery(p, glDate(new Date()), "all");   // a bad value falls back to the default, as on the page
  const format: ExportFormat = (EXPORT_FORMATS as readonly string[]).includes(p.format) ? (p.format as ExportFormat) : "xlsx";
  const file = await exportLedger(ledgerFilter(query), format, await currentUser(), requestOrigin(req.headers), query.period);
  return new Response(new Uint8Array(file.body), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": contentDisposition(file.filename, "attachment"),
      "Cache-Control": "no-store",
      "X-GL-Export-Batch": file.batch,
    },
  });
}
