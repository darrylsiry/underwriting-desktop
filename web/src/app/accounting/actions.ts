"use server";

import { redirect } from "next/navigation";
import { EXPORT_FORMATS, glDate, type ExportFormat } from "@/lib/gl-journal";
import { NothingToPushError, nothingToPushPath, parseLedgerQuery, pushedAccountingPath } from "@/lib/gl-query";
import { ledgerFilter } from "@/lib/gl-service";
import { pushLedger } from "@/lib/ledger";
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
  let pushed: Awaited<ReturnType<typeof pushLedger>>;
  try {
    pushed = await pushLedger(ledgerFilter(query), format, await currentUser());
  } catch (err) {
    if (err instanceof NothingToPushError) redirect(nothingToPushPath(p));
    throw err;
  }
  redirect(pushedAccountingPath(p, pushed.batch, pushed.fresh, format));
}
