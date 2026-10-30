import { glContext, jsonResponse } from "@/lib/gl-http";
import { batchesDocument } from "@/lib/gl-service";

export const dynamic = "force-dynamic";

/** GET /api/gl/batches: every push to the general ledger, newest first. */
export async function GET(req: Request) {
  return jsonResponse(await batchesDocument(await glContext(req)));
}
