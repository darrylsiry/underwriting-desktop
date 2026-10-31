"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { EXPORT_FORMATS, glDate, type ExportFormat } from "@/lib/gl-journal";
import { parseLedgerQuery, pushedAccountingPath } from "@/lib/gl-query";
import { ledgerFilter } from "@/lib/gl-service";
import { requestOrigin } from "@/lib/http";
import { exportLedger } from "@/lib/ledger";
import { currentUser } from "@/lib/user";

/**
 * The Export buttons' action (UX-022, UX-009): the same push as POST /accounting/export (stamp the
 * batch, audited, then back to the page with the batch named), as a server action so the buttons
 * can show "Preparing file…" while it runs. Next checks the Origin header on server actions.
 */
export async function pushToGlAction(form: FormData) {
  const p = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const { query } = parseLedgerQuery(p, glDate(new Date()), "all");
  const format: ExportFormat = (EXPORT_FORMATS as readonly string[]).includes(p.format) ? (p.format as ExportFormat) : "xlsx";
  const file = await exportLedger(ledgerFilter(query), format, await currentUser(), requestOrigin(await headers()), query.period);
  redirect(pushedAccountingPath(p, file.batch, file.fresh, format));
}
