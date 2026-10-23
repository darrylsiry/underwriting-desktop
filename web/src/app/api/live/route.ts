// Liveness for the platform's health check: the web process is up. No auth, no dependencies
// (/api/health checks databases and services and returns 503 when any is down).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
