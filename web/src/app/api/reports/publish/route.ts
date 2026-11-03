import { storePublished } from "@/lib/published-reports";
import { bearerOk, checkPublish, MAX_PUBLISH_BYTES } from "@/lib/report-publish";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: NO_STORE });

/**
 * POST /api/reports/publish: the machine that runs the review agents sends their latest reports, so
 * App Tests is current without a deploy (step 30; web/scripts/publish-reports.ts is the sender).
 * Past the sign-in gate on purpose: it has its own credential, REPORTS_PUBLISH_TOKEN, and logins
 * can't publish. With no token set, publishing is off and this path doesn't exist.
 */
export async function POST(req: Request) {
  const token = process.env.REPORTS_PUBLISH_TOKEN?.trim();
  if (!token) return refuse(404, "not_found", "Report publishing isn't turned on for this deployment.");
  if (!bearerOk(req.headers.get("authorization"), token)) return refuse(401, "unauthorized", "Send the publishing token as a Bearer token.");
  if (Number(req.headers.get("content-length")) > MAX_PUBLISH_BYTES) return refuse(413, "too_large", `A publish can be at most ${MAX_PUBLISH_BYTES} bytes.`);
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_PUBLISH_BYTES) return refuse(413, "too_large", `A publish can be at most ${MAX_PUBLISH_BYTES} bytes.`);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return refuse(400, "invalid_json", "The body isn't valid JSON.");
  }
  const checked = checkPublish(payload);
  if ("error" in checked) return refuse(400, "refused", `Nothing was published: ${checked.error}.`);
  const outcome = await storePublished(checked.files);
  if (outcome === "stale") return refuse(409, "stale", "Nothing was published: the deployment already holds a newer set of reports.");
  return Response.json({ outcome, files: checked.files.length }, { headers: NO_STORE });
}
