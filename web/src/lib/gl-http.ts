import { glDate } from "./gl-journal";
import type { ApiErrorCode } from "./gl-openapi";
import { parseLedgerQuery, type LedgerQuery } from "./gl-query";
import type { GlContext } from "./gl-service";
import { contentDisposition, requestOrigin } from "./http";
import type { LedgerFile } from "./ledger";
import { currentUser } from "./user";

// Plumbing shared by the /api/gl routes: who is calling, query parsing, and the JSON, error and
// file responses. Auth itself happens in middleware.ts (HTTP Basic with the underwriter logins).

const NO_STORE = { "Cache-Control": "no-store" };

export async function glContext(req: Request): Promise<GlContext> {
  return { actor: await currentUser(), origin: requestOrigin(req.headers) };
}

/** The ledger query from search params or a parsed body. Without a period, a batch filter means "all periods", like the Accounting page. */
export function ledgerQuery(p: Record<string, string | undefined>): { query: LedgerQuery; errors: string[] } {
  return parseLedgerQuery(p, glDate(new Date()), p.batch ? "all" : "this_month");
}

export const searchParamsOf = (req: Request): Record<string, string> => Object.fromEntries(new URL(req.url).searchParams);

export const jsonResponse = (doc: unknown, status = 200) => Response.json(doc, { status, headers: NO_STORE });

export function apiError(status: number, code: ApiErrorCode, message: string, details?: string[]) {
  return Response.json({ error: { code, message, ...(details?.length ? { details } : {}) } }, { status, headers: NO_STORE });
}

export function fileResponse(file: LedgerFile, extra: Record<string, string> = {}) {
  return new Response(new Uint8Array(file.body), {
    headers: { "Content-Type": file.contentType, "Content-Disposition": contentDisposition(file.filename, "attachment"), ...NO_STORE, ...extra },
  });
}
