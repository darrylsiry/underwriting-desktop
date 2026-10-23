import { NextResponse } from "next/server";
import { systemHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const components = await systemHealth();
  const ok = components.every((c) => c.ok);
  return NextResponse.json({ status: ok ? "ok" : "degraded", components }, { status: ok ? 200 : 503 });
}
