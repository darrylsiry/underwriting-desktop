import { apiError, glContext, jsonResponse, ledgerQuery, searchParamsOf } from "@/lib/gl-http";
import { summaryDocument } from "@/lib/gl-service";

export const dynamic = "force-dynamic";

/** GET /api/gl/summary: totals for a period, overall and by accounting month, without the journal detail. */
export async function GET(req: Request) {
  const { query, errors } = ledgerQuery(searchParamsOf(req));
  if (errors.length) return apiError(400, "bad_request", "Invalid query", errors);
  return jsonResponse(await summaryDocument(query, await glContext(req)));
}
