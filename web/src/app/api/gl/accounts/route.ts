import { jsonResponse } from "@/lib/gl-http";
import { accountsDocument } from "@/lib/gl-service";

export const dynamic = "force-dynamic";

/** GET /api/gl/accounts: the chart of accounts and the posting rule. */
export function GET() {
  return jsonResponse(accountsDocument());
}
