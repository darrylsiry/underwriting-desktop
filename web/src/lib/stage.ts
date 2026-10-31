// Where a submission stands, in the words the workbench and the desk use (UX-005). Pure module for node:test.

export type StageKey = "review" | "unrated" | "referred" | "ready" | "quoted" | "bound";

export type Stage = { key: StageKey; label: string; tone: "amber" | "slate" | "emerald" | "indigo"; href?: string };   // href: the policy, when bound (UX-038)

export type StageInput = {
  status: "needs_review" | "accepted";
  missing: number;                       // rating fields still empty on the intake
  worksheet: { rated: boolean; openReferrals: number } | null;   // null: no worksheet opened yet
  quote: { version: number; total: number | string; status: string } | null;   // the latest version
  policy: { id?: string; policy_number: string } | null;
};

const usd = (v: number | string) => `$${Math.round(Number(v)).toLocaleString("en-US")}`;

export function stageOf(x: StageInput): Stage {
  if (x.policy) return { key: "bound", label: `Bound ${x.policy.policy_number}`, tone: "emerald", ...(x.policy.id ? { href: `/policies/${x.policy.id}` } : {}) };
  if (x.quote) return { key: "quoted", label: `Quoted v${x.quote.version} · ${usd(x.quote.total)}`, tone: "indigo" };
  if (x.status === "needs_review") return { key: "review", label: x.missing ? `Needs review (${x.missing} missing)` : "Needs review", tone: "amber" };
  if (x.worksheet && x.worksheet.openReferrals > 0) {
    const n = x.worksheet.openReferrals;
    return { key: "referred", label: `${n} referral${n === 1 ? "" : "s"} open`, tone: "amber" };
  }
  if (!x.worksheet || !x.worksheet.rated) return { key: "unrated", label: "Not rated", tone: "slate" };
  return { key: "ready", label: "Ready to quote", tone: "emerald" };
}

export const STAGE_FILTERS: { key: StageKey; label: string }[] = [
  { key: "review", label: "Needs review" }, { key: "unrated", label: "Not rated" }, { key: "referred", label: "Referrals open" },
  { key: "ready", label: "Ready to quote" }, { key: "quoted", label: "Quoted" }, { key: "bound", label: "Bound" },
];

export const isStageKey = (s: string | undefined): s is StageKey => STAGE_FILTERS.some((f) => f.key === s);

/** `62 submissions · 3 need review · 2 referrals open · newest first` */
export function stageSummary(stages: Stage[]): string {
  const n = stages.length;
  const review = stages.filter((s) => s.key === "review").length;
  const referred = stages.filter((s) => s.key === "referred").length;
  const ready = stages.filter((s) => s.key === "ready").length;
  const parts = [`${n} submission${n === 1 ? "" : "s"}`];
  if (review) parts.push(`${review} need${review === 1 ? "s" : ""} review`);
  if (referred) parts.push(`${referred} with referrals open`);
  if (ready) parts.push(`${ready} ready to quote`);
  parts.push("newest first");
  return parts.join(" · ");
}
