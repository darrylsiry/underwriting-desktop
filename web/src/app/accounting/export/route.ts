import { EXPORT_FORMATS, glDate, type ExportFormat } from "@/lib/gl-journal";
import { NothingToPushError, nothingToPushPath, parseLedgerQuery, pushedAccountingPath } from "@/lib/gl-query";
import { ledgerFilter } from "@/lib/gl-service";
import { CROSS_SITE_REFUSED, requestOrigin, sameOrigin } from "@/lib/http";
import { pushLedger } from "@/lib/ledger";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

/**
 * Push the filtered sub-ledger to the GL: a POST from the Accounting page that marks the lines and
 * sends the browser back to the page, which confirms the batch and starts the download (UX-022).
 * The file itself is served by GET /api/gl/postings with the same filter, which stamps nothing.
 */
export async function POST(req: Request) {
  // Stamps ledger lines with a batch in the user's name: only this site's own page may ask (CR-065).
  if (!sameOrigin(req.headers)) return new Response(CROSS_SITE_REFUSED, { status: 403, headers: { "Content-Type": "text/plain" } });
  const form = await req.formData();
  const p = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const { query } = parseLedgerQuery(p, glDate(new Date()), "all");   // a bad value falls back to the default, as on the page
  const format: ExportFormat = (EXPORT_FORMATS as readonly string[]).includes(p.format) ? (p.format as ExportFormat) : "xlsx";
  const origin = requestOrigin(req.headers);
  try {
    const { batch, fresh } = await pushLedger(ledgerFilter(query), format, await currentUser());
    return Response.redirect(`${origin}${pushedAccountingPath(p, batch, fresh, format)}`, 303);
  } catch (err) {
    if (err instanceof NothingToPushError) return Response.redirect(`${origin}${nothingToPushPath(p)}`, 303);
    throw err;
  }
}
