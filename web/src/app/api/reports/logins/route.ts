import { toCsv } from "@/lib/csv";
import { contentDisposition, requestOrigin } from "@/lib/http";
import { allLoginEvents, loginReport } from "@/lib/login-events";
import { EVENT_CSV_HEADER, eventCsvRow, reportMarkdown } from "@/lib/login-meta";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/reports/logins: the sign-in report (who signed in over the last 24 hours and all time,
 * with IP, location, browser). Behind the same login as the rest of the API (HTTP Basic).
 *   ?format=json (default)   the report as data
 *   ?format=md               Markdown, what scripts/login-report.sh files each day
 *   ?format=csv              every recorded attempt, one row each
 *   &hours=24                the recent window
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const format = p.get("format") ?? "json";
  const hours = Math.min(24 * 90, Math.max(1, Number(p.get("hours")) || 24));
  const day = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const events = await allLoginEvents();
    return new Response(toCsv(EVENT_CSV_HEADER, events.map(eventCsvRow)), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(`sign-ins-${day}.csv`, "attachment"), ...NO_STORE },
    });
  }
  const report = await loginReport({ windowHours: hours });
  if (format === "md") {
    return new Response(reportMarkdown(report, requestOrigin(req.headers)), { headers: { "Content-Type": "text/markdown; charset=utf-8", ...NO_STORE } });
  }
  return Response.json(report, { headers: NO_STORE });
}
