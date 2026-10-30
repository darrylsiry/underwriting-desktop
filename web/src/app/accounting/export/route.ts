import { PERIOD_PRESETS, TRANSACTION_LABEL, glDate, presetRange, type PeriodPreset, type TransactionType } from "@/lib/gl-journal";
import { contentDisposition } from "@/lib/http";
import { exportLedger, type ExportFormat } from "@/lib/ledger";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Push the filtered sub-ledger to the GL: a POST from the Accounting page that downloads the file and marks the lines. */
export async function POST(req: Request) {
  const form = await req.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const format: ExportFormat = get("format") === "csv" ? "csv" : "xlsx";
  const preset: PeriodPreset = (PERIOD_PRESETS as readonly string[]).includes(get("period")) ? (get("period") as PeriodPreset) : "all";
  const range = presetRange(preset, glDate(new Date()), { from: isDate(get("from")) ? get("from") : null, to: isDate(get("to")) ? get("to") : null });
  const type = get("type") in TRANSACTION_LABEL ? (get("type") as TransactionType) : "";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const file = await exportLedger({ from: range.from, to: range.to, type, batch: get("batch") }, format, await currentUser(), `${proto}://${host}`);
  return new Response(new Uint8Array(file.body), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": contentDisposition(file.filename, "attachment"),
      "Cache-Control": "no-store",
      "X-GL-Export-Batch": file.batch,
    },
  });
}
