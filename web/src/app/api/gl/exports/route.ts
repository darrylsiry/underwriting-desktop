import { apiError, fileResponse, glContext, jsonResponse, ledgerQuery, searchParamsOf } from "@/lib/gl-http";
import { pushDocument } from "@/lib/gl-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/gl/exports: push the filter's lines to the general ledger. Lines not pushed before are
 * stamped with a new batch and the push is audited, exactly like the button on the Accounting page.
 * JSON format answers with the push record and the ledger document; CSV and Excel answer with the file.
 */
export async function POST(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};
  try {
    if (ct.includes("application/json")) body = (await req.json()) ?? {};
    else if (ct.includes("form")) body = Object.fromEntries(await req.formData());
  } catch {
    return apiError(400, "bad_request", "The body must be a JSON object such as {\"period\": \"last_month\", \"format\": \"csv\"}");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return apiError(400, "bad_request", "The body must be a JSON object");
  const params = { ...searchParamsOf(req), ...Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v == null ? undefined : String(v)])) };
  const { query, errors } = ledgerQuery(params);
  if (errors.length) return apiError(400, "bad_request", "Invalid export request", errors);

  const { file, document } = await pushDocument(query, query.format, await glContext(req));
  if (query.format === "json") return jsonResponse({ push: document, ledger: JSON.parse(new TextDecoder().decode(file.body)) }, 201);
  return fileResponse(file, { "X-GL-Export-Batch": document.batch, "X-GL-Newly-Stamped-Lines": String(document.newly_stamped_lines) });
}
