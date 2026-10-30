// Referral rules: deterministic checks an underwriter's authority depends on.
// "refer" flags must be cleared with a written note before quoting; "warn" flags
// are things to look at. Pure module (type-only imports) so node:test can load it.
import type { Extraction, Loss, SubmissionData } from "./submission";
import type { Clearance, RatingInputs, ScheduleItem } from "./worksheet";

export type Flag = { code: string; severity: "refer" | "warn"; title: string; detail: string };

export type ReferralContext = {
  data: SubmissionData;
  extraction: Pick<Extraction, "fields" | "documents">;
  correctedFields: string[];
  inputs: RatingInputs;
  schedule: ScheduleItem[];
};

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

export const LIMITS = {
  largeOpenClaim: 100_000,
  claimCount: 3,
  noCoiSubPct: 25,
  heavySubPct: 50,
  heightFt: 50,
  receipts: 15_000_000,
  occurrenceLimit: 1_000_000,
  scheduleAuthorityPct: 15,
  newVentureYears: 3,
};

/**
 * Whether a claim is still open. Loss runs write status many ways ("O", "OPEN-LIT", "Reopened",
 * "Pending", "Closed - paid", "CWP"); ingestion normalizes what it recognizes, and here anything
 * not recognizably closed counts as open, so a large claim of unknown status is referred (CR-030).
 */
export function isOpenLoss(status: string | null | undefined): boolean {
  return !/^\s*(c|cl|clsd|closed|paid|settled|denied|declined|cwp|cwop|withdrawn)\b/i.test(status ?? "");
}

/**
 * A clearance only covers the facts it was given for: if the flag's detail changed since
 * (height 55 ft -> 150 ft, receipts $15M -> $80M), the referral is open again.
 */
export function clearanceStatus(flag: Flag, clearance: Clearance | undefined): "cleared" | "stale" | "open" {
  if (!clearance) return "open";
  return clearance.detail === flag.detail ? "cleared" : "stale";
}

export function referralFlags(ctx: ReferralContext): Flag[] {
  const { data, inputs, schedule } = ctx;
  const losses: Loss[] = data.loss_history ?? [];
  const flags: Flag[] = [];
  const add = (code: string, severity: Flag["severity"], title: string, detail: string) =>
    flags.push({ code, severity, title, detail });

  const bigOpen = losses.filter((l) => isOpenLoss(l.status) && l.incurred >= LIMITS.largeOpenClaim);
  if (bigOpen.length) {
    add("LARGE_OPEN_CLAIM", "refer", "Large open claim",
      bigOpen.map((l) => `${l.date}: ${l.description} (${money(l.incurred)} incurred, open)`).join("; "));
  }
  if (losses.length >= LIMITS.claimCount) {
    const total = losses.reduce((s, l) => s + l.incurred, 0);
    add("LOSS_FREQUENCY", "refer", "Loss frequency", `${losses.length} claims in the loss history, ${money(total)} incurred`);
  }
  if (inputs.subcontracted_pct >= LIMITS.noCoiSubPct && !inputs.subcontractor_coi_required) {
    add("UNINSURED_SUBS", "refer", "Subcontractors without COIs",
      `${inputs.subcontracted_pct}% of work subcontracted and certificates of insurance aren't required`);
  } else if (inputs.subcontracted_pct >= LIMITS.heavySubPct) {
    add("HEAVY_SUBCONTRACTING", "warn", "Heavy subcontracting",
      `${inputs.subcontracted_pct}% of work subcontracted; confirm subs' limits and additional-insured wording`);
  }
  if (inputs.states.includes("NY")) {
    add("NY_LABOR_LAW", "refer", "New York operations",
      "Labor Law 240/241 (scaffold law) exposure; requires manager approval and Action Over review");
  }
  if (inputs.max_height_ft >= LIMITS.heightFt) {
    add("HEIGHT", "refer", "Work at height", `Maximum working height ${inputs.max_height_ft} ft (limit ${LIMITS.heightFt} ft)`);
  }
  if (inputs.class_code === "98677") {
    add("ROOFING", "refer", "Roofing class", "Roofing (98677) is written only with manager approval");
  }
  if (inputs.gross_receipts > LIMITS.receipts) {
    add("LARGE_ACCOUNT", "refer", "Above receipts authority", `${money(inputs.gross_receipts)} gross receipts (authority ${money(LIMITS.receipts)})`);
  }
  if (inputs.occurrence_limit > LIMITS.occurrenceLimit) {
    add("HIGH_LIMITS", "refer", "Limits above authority", `${money(inputs.occurrence_limit)} per occurrence (authority ${money(LIMITS.occurrenceLimit)})`);
  }
  const total = schedule.reduce((s, i) => s + i.pct, 0);
  if (Math.abs(total) > LIMITS.scheduleAuthorityPct) {
    add("SCHEDULE_AUTHORITY", "refer", "Schedule mod above authority",
      `Total schedule ${total > 0 ? "+" : ""}${total}% (authority ±${LIMITS.scheduleAuthorityPct}%)`);
  }

  const years = data.applicant?.years_in_business;
  if (typeof years === "number" && years < LIMITS.newVentureYears) {
    add("NEW_VENTURE", "warn", "New venture", `${years} year(s) in business`);
  }
  // The warning is about the class Claude inferred; once the underwriter corrected it (on intake or
  // by changing the class on the workbench) it no longer applies (CR-055).
  const classMeta = ctx.extraction.fields["operations.class_code"];
  if (classMeta?.basis === "inferred" && !ctx.correctedFields.includes("operations.class_code") && String(classMeta.value) === inputs.class_code) {
    add("CLASS_INFERRED", "warn", "Class code inferred", `Class ${classMeta.value} was inferred from "${classMeta.snippet}"; confirm with the broker`);
  }
  // Loss runs are asked for whether or not tenure is known; a younger business is asked for all of its years (CR-062).
  if (!ctx.extraction.documents.some((d) => d.doc_type === "loss_run")) {
    add("NO_LOSS_RUNS", "warn", "No loss runs", `No loss run was submitted; request ${lossRunYears(years)} of currently valued loss runs`);
  }
  return flags;
}

/** How much loss history to ask for: five years, or every year of a business younger than that. */
export function lossRunYears(yearsInBusiness: unknown): string {
  return typeof yearsInBusiness === "number" && yearsInBusiness < 5
    ? `all ${yearsInBusiness} year${yearsInBusiness === 1 ? "" : "s"} in business`
    : "5 years";
}
