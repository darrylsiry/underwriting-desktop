import { apiError, fileResponse, glContext, jsonResponse, ledgerQuery, searchParamsOf } from "@/lib/gl-http";
import { postingsDocument, postingsFile } from "@/lib/gl-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/gl/postings: the sub-ledger for a period (preset or from/to), type and batch, as JSON journals or a CSV/Excel file.
 * Reads only; stamps nothing. `download=1` asks for JSON as a file to save (the Accounting page's download, UAT-F2);
 * without it JSON is the plain API answer.
 */
export async function GET(req: Request) {
  const params = searchParamsOf(req);
  const { query, errors } = ledgerQuery(params);
  if (errors.length) return apiError(400, "bad_request", "Invalid query", errors);
  const ctx = await glContext(req);
  if (query.format === "json" && params.download !== "1") return jsonResponse(await postingsDocument(query, ctx));
  return fileResponse(await postingsFile(query, ctx));
}
