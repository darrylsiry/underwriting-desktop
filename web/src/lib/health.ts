import { pools, type DbName } from "./db";
import { INGESTION_SERVICE_URL, RATING_SERVICE_URL } from "./services";

export type ComponentStatus = { name: string; kind: "database" | "service"; ok: boolean; detail: string; timedOut?: boolean };

// Long enough for a Fly machine to start when the first visit of the day wakes it (CR-041).
const SERVICE_TIMEOUT_MS = 15_000;

async function checkDb(name: DbName): Promise<ComponentStatus> {
  try {
    await pools[name].query("SELECT 1");
    return { name: `${name} db`, kind: "database", ok: true, detail: "connected" };
  } catch (err) {
    return { name: `${name} db`, kind: "database", ok: false, detail: (err as Error).message };
  }
}

async function checkService(name: string, url: string, timeoutMs: number): Promise<ComponentStatus> {
  try {
    const res = await fetch(`${url}/health`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    const extra = Object.entries(body)
      .filter(([k]) => !["service", "status"].includes(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return { name, kind: "service", ok: res.ok, detail: extra || body.status };
  } catch (err) {
    if ((err as Error).name === "TimeoutError") return { name, kind: "service", ok: false, detail: `no answer in ${timeoutMs / 1000} s; it may be starting`, timedOut: true };
    return { name, kind: "service", ok: false, detail: (err as Error).message };
  }
}

export async function systemHealth({ serviceTimeoutMs = SERVICE_TIMEOUT_MS } = {}): Promise<ComponentStatus[]> {
  return Promise.all([
    checkDb("customer"),
    checkDb("policy"),
    checkService("rating-service", RATING_SERVICE_URL, serviceTimeoutMs),
    checkService("ingestion-service", INGESTION_SERVICE_URL, serviceTimeoutMs),
  ]);
}
