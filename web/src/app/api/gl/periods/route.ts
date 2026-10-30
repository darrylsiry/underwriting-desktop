import { glContext, jsonResponse } from "@/lib/gl-http";
import { periodsDocument } from "@/lib/gl-service";

export const dynamic = "force-dynamic";

/** GET /api/gl/periods: every accounting month with bookings and its totals. */
export async function GET(req: Request) {
  return jsonResponse(await periodsDocument(await glContext(req)));
}
