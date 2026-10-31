import { EXPORT_FORMATS, glDate, type ExportFormat } from "@/lib/gl-journal";
import { parseLedgerQuery, pushedAccountingPath } from "@/lib/gl-query";
import { ledgerFilter } from "@/lib/gl-service";
import { CROSS_SITE_REFUSED, requestOrigin, sameOrigin } from "@/lib/http";
import { exportLedger } from "@/lib/ledger";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

/**
 * Push the filtered sub-ledger to the GL: a POST from the Accounting page that marks the lines and
 * sends the browser back to the page, which confirms the batch and starts the download (UX-022).
 * The file itself is served by GET /api/gl/postings?batch=…, which stamps nothing.
 */
export async function POST(req: Request) {
  // Stamps ledger lines with a batch in the user's name: only this site's own page may ask (CR-065).
  if (!sameOrigin(req.headers)) return new Response(CROSS_SITE_REFUSED, { status: 403, headers: { "Content-Type": "text/plain" } });
  const form = await req.formData();
  const p = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const { query } = parseLedgerQuery(p, glDate(new Date()), "all");   // a bad value falls back to the default, as on the page
  const format: ExportFormat = (EXPORT_FORMATS as readonly string[]).includes(p.format) ? (p.format as ExportFormat) : "xlsx";
  const origin = requestOrigin(req.headers);
  const file = await exportLedger(ledgerFilter(query), format, await currentUser(), origin, query.period);
  return Response.redirect(`${origin}${pushedAccountingPath(p, file.batch, file.fresh, format)}`, 303);
}
