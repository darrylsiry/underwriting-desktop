import { apiError, glContext, jsonResponse } from "@/lib/gl-http";
import { journalDocument } from "@/lib/gl-service";

export const dynamic = "force-dynamic";

/** GET /api/gl/journals/{journal_no}: one journal with its lines, policy details and the audit events of the underwriting action behind it. */
export async function GET(req: Request, { params }: { params: Promise<{ journal_no: string }> }) {
  const { journal_no } = await params;
  if (!/^JE-\d{6,}$/.test(journal_no)) return apiError(400, "bad_request", "journal_no must look like JE-000001");
  const doc = await journalDocument(journal_no, await glContext(req));
  return doc ? jsonResponse(doc) : apiError(404, "not_found", `No journal ${journal_no} has been booked`);
}
