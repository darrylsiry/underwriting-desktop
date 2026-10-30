// Seeded history: a year of policies bound in the UW Desktop. Each one goes through the real
// pipeline (submission received, intake accepted, worksheet rated, referrals cleared, quote issued,
// bound) at back-dated times, so the desk, the policies list, the renewal register, the premium
// sub-ledger and the audit trail all show a book that has been written since January rather than
// a handful of policies bound today. Runs once at startup when SEED_HISTORY=<count> is set and
// skips any insured that already exists, so it's safe to leave on. Names are fictitious; the
// numbers come from the rating service on the rates in force now.
import { loadUsers } from "./basic-auth";
import { customerDb } from "./db";
import { bindQuote } from "./policies";
import { addDays, addYears, suggestedSubjectivities } from "./quote-terms";
import { issueQuote } from "./quotes";
import { FIELD_DEFS, getPath, type Extraction, type FieldMeta, type Loss, type SubmissionData } from "./submission";
import { acceptSubmission, getSubmission, storeSubmission } from "./submissions";
import type { ScheduleItem } from "./worksheet";
import { activeRateVersion, clearReferral, flagsFor, getWorksheet, readiness, saveAndRate } from "./worksheets";

export const HISTORY_START = "2026-01-01";

// ---- vocabularies (the prior-system book uses the same classes, places and producers) ------------

type ClassDef = { desc: string; trades: string[]; receipts: [number, number]; residential: [number, number]; height: [number, number]; subs: [number, number]; ops: string; losses: string[] };
const CLASSES: Record<string, ClassDef> = {
  "91342": { desc: "Carpentry - residential (interior finish)", trades: ["Finish Carpentry", "Millwork", "Cabinet & Trim"], receipts: [600_000, 3_500_000], residential: [60, 100], height: [10, 25], subs: [0, 20],
    ops: "Interior finish carpentry: trim, doors, cabinetry and millwork installation in new and remodeled homes", losses: ["Completed operations: cabinet mounting failure", "Floor damage during trim installation", "Slip and fall on a job site"] },
  "91560": { desc: "Concrete construction (flatwork, foundations)", trades: ["Concrete", "Flatwork", "Foundations"], receipts: [1_500_000, 9_000_000], residential: [10, 60], height: [5, 20], subs: [0, 25],
    ops: "Concrete flatwork, slabs, driveways and residential and light commercial foundations; no post-tensioned or structural high-rise work", losses: ["Property damage: cut irrigation line", "Vehicle damage from concrete splatter", "Trip and fall over formwork"] },
  "91583": { desc: "General contractor - remodel / renovation", trades: ["Builders", "Construction", "Renovations"], receipts: [2_000_000, 14_000_000], residential: [30, 90], height: [20, 45], subs: [20, 45],
    ops: "General contractor for remodel and renovation projects, subcontracting mechanical trades under written contracts with additional-insured requirements", losses: ["Water damage after a plumbing sub's fitting failed", "Third-party injury from falling debris", "Damage to adjoining tenant space"] },
  "92215": { desc: "Electrical work - within buildings", trades: ["Electric", "Electrical Contractors", "Power & Lighting"], receipts: [900_000, 8_000_000], residential: [10, 70], height: [15, 45], subs: [0, 20],
    ops: "Electrical installation and service work within commercial and residential buildings; no utility, transmission or high-voltage work", losses: ["Fire damage traced to a junction box", "Ladder fell against a customer vehicle", "Completed operations: panel short"] },
  "97050": { desc: "HVAC systems - commercial", trades: ["Mechanical", "Air Systems", "HVAC Services"], receipts: [1_000_000, 9_000_000], residential: [0, 30], height: [15, 45], subs: [0, 25],
    ops: "Commercial HVAC installation, replacement and service; rooftop units and ductwork; no boiler manufacturing or refrigeration plants", losses: ["Water damage from a condensate line", "Drywall damage during duct installation", "Refrigerant release on a rooftop unit"] },
  "98304": { desc: "Painting - exterior / interior", trades: ["Painting", "Coatings", "Painting & Restoration"], receipts: [400_000, 3_000_000], residential: [30, 95], height: [15, 35], subs: [0, 20],
    ops: "Interior and exterior painting and protective coatings for residential and light commercial buildings; no lead abatement, bridge or tank work", losses: ["Overspray on neighboring vehicles", "Floor finish damage from solvent", "Scaffold contact with a parked car"] },
  "98482": { desc: "Plumbing - commercial and industrial", trades: ["Plumbing", "Pipe & Mechanical", "Plumbing Services"], receipts: [1_200_000, 10_000_000], residential: [0, 40], height: [10, 35], subs: [0, 20],
    ops: "Commercial and industrial plumbing, process piping and service work; no gas transmission, fire suppression or medical gas", losses: ["Water damage from a failed solder joint", "Completed operations: backflow valve leak", "Sewer line damage during excavation"] },
  "98677": { desc: "Roofing - residential", trades: ["Roofing", "Roof Systems", "Exteriors"], receipts: [800_000, 4_500_000], residential: [70, 100], height: [20, 35], subs: [0, 30],
    ops: "Residential re-roofing and repair, shingle and tile; no torch-applied or hot work, no commercial flat roofs", losses: ["Interior water damage during a re-roof", "Fallen material damaged a vehicle", "Gutter damage on an adjoining home"] },
};
const CLASS_WEIGHTS: [string, number][] = [["91583", 20], ["92215", 16], ["98482", 15], ["91560", 12], ["97050", 12], ["98304", 10], ["91342", 9], ["98677", 6]];

// States the rate tables carry a territory for (NY is left out: it always refers for Labor Law).
const STATE_WEIGHTS: Record<string, number> = { TX: 18, FL: 16, AZ: 12, CO: 11, GA: 9, NV: 8, WA: 8, SC: 7, NJ: 6, WY: 5 };
const NEIGHBORS: Record<string, string[]> = { TX: ["TX"], FL: ["FL", "GA"], GA: ["GA", "SC"], SC: ["SC", "GA"], AZ: ["AZ", "NV"], NV: ["NV", "AZ"], CO: ["CO", "WY"], WY: ["WY", "CO"], WA: ["WA"], NJ: ["NJ"] };
const PLACES: Record<string, string[]> = {
  TX: ["Brazos", "Hill Country", "Gulf Plains", "Pecos", "Trinity", "Lone Star"], FL: ["Suncoast", "Palm Harbor", "Everglades", "Gulf Breeze", "Treasure Coast"],
  GA: ["Chattahoochee", "Savannah River", "Blue Ridge", "Peachtree"], SC: ["Palmetto", "Lowcountry", "Congaree"], AZ: ["Saguaro", "Mesa Verde", "Red Rock", "Sonoran", "Copper Canyon"],
  NV: ["Silver State", "High Desert", "Tahoe", "Sierra Vista"], CO: ["Summit", "Pikes Peak", "Front Range", "Aspen Grove"], WY: ["Wind River", "Teton", "Bighorn"],
  WA: ["Cascade", "Olympic", "Puget", "Rainier"], NJ: ["Garden State", "Pinelands", "Raritan"],
};
const CITIES: Record<string, [string, string][]> = {
  TX: [["Houston", "770"], ["Dallas", "752"], ["Austin", "787"], ["San Antonio", "782"], ["Fort Worth", "761"]], FL: [["Tampa", "336"], ["Orlando", "328"], ["Jacksonville", "322"], ["Fort Myers", "339"], ["Sarasota", "342"]],
  GA: [["Atlanta", "303"], ["Savannah", "314"], ["Macon", "312"]], SC: [["Charleston", "294"], ["Greenville", "296"], ["Columbia", "292"]], AZ: [["Phoenix", "850"], ["Tucson", "857"], ["Mesa", "852"], ["Chandler", "852"]],
  NV: [["Las Vegas", "891"], ["Reno", "895"], ["Henderson", "890"]], CO: [["Denver", "802"], ["Colorado Springs", "809"], ["Fort Collins", "805"]], WY: [["Cheyenne", "820"], ["Casper", "826"]],
  WA: [["Seattle", "981"], ["Tacoma", "984"], ["Spokane", "992"]], NJ: [["Newark", "071"], ["Edison", "088"], ["Cherry Hill", "080"]],
};
const STREETS = ["Industrial Blvd", "Commerce Dr", "Enterprise Way", "Frontage Rd", "Mill St", "Airport Rd", "Trade Center Pkwy", "Ranch Rd", "Harbor View Dr", "Cedar Ave", "Depot St", "Quarry Ln"];
const SUFFIXES: [string, string][] = [["LLC", "LLC"], ["Inc.", "Corporation"], ["Corp.", "Corporation"], ["Co.", "Corporation"], ["LLC", "LLC"]];
const PRODUCERS = [
  "Alamo Specialty Brokers", "Big Sky Brokerage Group", "Catskill Specialty Agency", "Copper State Insurance Group", "Coral Gables Excess & Surplus",
  "Desert Peak Insurance Services", "Evergreen Wholesale Brokers", "Front Range Wholesale", "Gulf Coast E&S Partners", "Palmetto Specialty Underwriters",
  "Southern Risk Advisors", "Lone Star Specialty Brokers",
];
const FIRST = ["Maria", "James", "Priya", "Daniel", "Aisha", "Robert", "Elena", "Marcus", "Hannah", "Luis", "Grace", "Tomas", "Nadia", "Kevin", "Olivia", "Samir"];
const LAST = ["Alvarez", "Chen", "Patel", "Okafor", "Nguyen", "Brooks", "Romero", "Kowalski", "Haddad", "Fischer", "Delgado", "Murphy", "Sato", "Lindqvist", "Ortega", "Reyes"];
const PRIOR_CARRIERS = ["Westbridge Specialty", "Harbor Point E&S", "Ridgeline Excess", "Meridian Surplus Lines", "Cobalt Specialty", "Northgate Underwriters"];

const CLEARANCE_NOTES: Record<string, string> = {
  ROOFING: "Manager approval on file (GL product lead): residential re-roof and repair only, no torch-applied or hot work, five years loss-free per loss runs, written fall-protection program confirmed with the broker.",
  HEIGHT: "Work above 50 ft is limited to aerial lifts with a harnessed fall-protection program the broker documented; manager agreed to write it at the quoted height.",
  UNINSURED_SUBS: "Broker confirmed a certificate program starts at inception and sent a sample subcontract with hold-harmless and additional-insured wording.",
  HEAVY_SUBCONTRACTING: "Subcontractors carry equal limits with additional-insured wording per the sample agreement received.",
  LARGE_ACCOUNT: "Manager approved the account above the receipts authority on the quoted terms.",
  LOSS_FREQUENCY: "Claims reviewed with the manager: small, closed and not repeated after the safety program began.",
};
const RATIONALE: Record<string, [string, string]> = {   // [credit, debit]
  management: ["Owner-operated for 20+ years with a dedicated safety lead and documented QA on every job", "Recent ownership change; management experience in this trade still being established"],
  safety: ["Written safety program, weekly toolbox talks and OSHA 30 for every supervisor", "No written safety program; training is informal"],
  subcontractor_controls: ["Written subcontracts with hold-harmless and additional-insured wording; certificates tracked", "Subcontract agreements lack additional-insured wording and certificates are collected inconsistently"],
  equipment: ["Fleet and lifts under a documented inspection program", "Aging equipment with no documented inspection program"],
  loss_experience: ["Five years loss-free, confirmed by currently valued loss runs", "Two paid losses in the period with the same cause of loss"],
  classification: ["Operations are at the low-hazard end of the class (service and repair work)", "A share of operations is heavier than the class contemplates"],
};

// ---- deterministic randomness ----------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const between = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const weighted = (r: Rng, items: [string, number][]) => {
  let n = r() * items.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of items) { n -= w; if (n <= 0) return k; }
  return items[items.length - 1][0];
};
const roundTo = (n: number, to: number) => Math.round(n / to) * to;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// ---- one risk ----------------------------------------------------------------------------------

export type SeedTimes = { received: Date; accepted: Date; rated: Date; cleared: Date; issued: Date; bound: Date };
export type SeedRisk = {
  name: string; fein: string; underwriter: string; effective: string; expiration: string;
  extraction: Extraction; form: Record<string, string>; times: SeedTimes; leaveOneSubjectivityOpen: boolean;
};

const at = (iso: string, hourUtc: number, minute: number) => new Date(`${iso}T${String(hourUtc).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
const laterThan = (d: Date, prev: Date) => (d.getTime() > prev.getTime() ? d : new Date(prev.getTime() + 25 * 60_000));

/** The dates one file moved through: received → accepted → rated → quoted → bound, bound on or before the effective date and never in the future. */
export function seedTimes(r: Rng, effective: string, now: Date): SeedTimes {
  const today = now.toISOString().slice(0, 10);
  let bound = addDays(effective, -between(r, 0, 21));
  if (bound < HISTORY_START) bound = HISTORY_START;
  if (bound > today) bound = today;
  const issued = addDays(bound, -between(r, 1, 10));
  const rated = addDays(issued, -between(r, 0, 2));
  const accepted = addDays(rated, -between(r, 0, 3));
  const received = addDays(accepted, -between(r, 1, 9));
  const t = {} as SeedTimes;
  t.received = at(received, between(r, 13, 16), between(r, 0, 59));
  t.accepted = laterThan(at(accepted, between(r, 15, 20), between(r, 0, 59)), t.received);
  t.rated = laterThan(at(rated, between(r, 14, 21), between(r, 0, 59)), t.accepted);
  t.cleared = new Date(t.rated.getTime() + between(r, 20, 90) * 60_000);
  t.issued = laterThan(at(issued, between(r, 14, 22), between(r, 0, 59)), t.cleared);
  t.bound = laterThan(at(bound, between(r, 14, 22), between(r, 0, 59)), t.issued);
  if (t.bound.getTime() > now.getTime() - 60_000) t.bound = new Date(now.getTime() - 60_000);
  return t;
}

/** Effective dates spread evenly from HISTORY_START to a few weeks out, with a little jitter. */
export function effectiveDates(r: Rng, count: number, now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${HISTORY_START}T00:00:00Z`)) / 86_400_000) + 14;
  return Array.from({ length: count }, (_, i) => {
    let d = addDays(HISTORY_START, Math.round((i * span) / Math.max(1, count - 1)) + between(r, -2, 2));
    if (d < HISTORY_START) d = HISTORY_START;
    return d;
  });
}

function buildRisk(r: Rng, i: number, effective: string, underwriter: string, now: Date, taken: Set<string>): SeedRisk {
  const code = weighted(r, CLASS_WEIGHTS);
  const c = CLASSES[code];
  const home = weighted(r, Object.entries(STATE_WEIGHTS));
  let name = "";
  for (let tries = 0; tries < 20 && (!name || taken.has(name)); tries++) {
    name = `${pick(r, PLACES[home])} ${pick(r, c.trades)} ${pick(r, SUFFIXES)[0]}`;
  }
  taken.add(name);
  const [suffixLabel, entityType] = SUFFIXES.find(([s]) => name.endsWith(s)) ?? SUFFIXES[0];
  void suffixLabel;
  const [city, zipPrefix] = pick(r, CITIES[home]);
  const states = r() < 0.6 ? [home] : [...new Set([home, ...NEIGHBORS[home]])];
  const receipts = roundTo(Math.exp(Math.log(c.receipts[0]) + r() * (Math.log(c.receipts[1]) - Math.log(c.receipts[0]))), 10_000);
  const years = between(r, 3, 38);
  const residential = between(r, c.residential[0], c.residential[1]);
  const subs = between(r, c.subs[0], c.subs[1]);
  const height = i % 17 === 5 ? 55 : between(r, c.height[0], c.height[1]);
  const aggregate = r() < 0.2 ? 3_000_000 : 2_000_000;
  const deductible = weighted(r, [["0", 1], ["1000", 2], ["2500", 4], ["5000", 4], ["10000", 2]]);
  const mod = r() < 0.55 ? 1 : Math.round((0.85 + r() * 0.3) * 100) / 100;
  const fein = `${between(r, 20, 99)}-${String(1_000_000 + Math.floor(r() * 8_999_999))}`;
  const contact = `${pick(r, FIRST)} ${pick(r, LAST)}`;
  const agency = pick(r, PRODUCERS);
  const lossCount = weighted(r, [["0", 5], ["1", 3], ["2", 2]]);
  const losses: Loss[] = Array.from({ length: Number(lossCount) }, (_, k) => {
    const incurred = roundTo(2_000 + r() * (k === 0 ? 58_000 : 25_000), 100);
    const year = Number(effective.slice(0, 4)) - between(r, 1, 4);
    return { date: `${year}-${String(between(r, 1, 12)).padStart(2, "0")}-${String(between(r, 1, 28)).padStart(2, "0")}`, description: pick(r, c.losses), incurred, status: r() < 0.15 && incurred < 60_000 ? "Open" : "Closed" };
  });
  const baseRate: Record<string, number> = { "91342": 9.4, "91560": 7.3, "91583": 11.5, "92215": 6.5, "97050": 5.1, "98304": 8.2, "98482": 7.5, "98677": 22 };
  const priorPremium = roundTo((receipts / 1000) * baseRate[code] * (0.9 + r() * 0.25), 100);
  const slug = slugify(name);

  const data = {
    applicant: { name, dba: "", street: `${between(r, 100, 9800)} ${pick(r, STREETS)}`, city, state: home, zip: `${zipPrefix}${String(between(r, 10, 99))}`, fein, entity_type: entityType, years_in_business: years, website: r() < 0.6 ? `https://www.${slug.replace(/-(llc|inc|corp|co)$/, "")}.example` : "" },
    operations: { description: c.ops, class_code: code, states, gross_receipts: receipts, payroll: roundTo(receipts * (0.24 + r() * 0.12), 1000), employees: Math.max(3, Math.round(receipts / 180_000)), subcontracted_pct: subs, subcontractor_coi_required: true, residential_pct: residential, new_construction_pct: between(r, 10, 60), max_height_ft: height, wrap_up_projects: false },
    policy: { effective_date: effective, expiration_date: addYears(effective, 1), occurrence_limit: 1_000_000, aggregate_limit: aggregate, products_aggregate_limit: aggregate, deductible: Number(deductible) },
    producer: { agency, contact, email: `${contact.toLowerCase().replace(" ", ".")}@${slugify(agency).replace(/-/g, "")}.example`, phone: `(${between(r, 201, 989)}) 555-01${String(between(r, 10, 99))}` },
    prior: { carrier: pick(r, PRIOR_CARRIERS), premium: priorPremium },
    loss_history: losses,
  } as unknown as SubmissionData;
  const application = `${slug}-acord-125.pdf`;
  const fields: Record<string, FieldMeta> = {};
  for (const def of FIELD_DEFS) {
    const value = getPath(data, def.path);
    if (value === null || value === "") continue;
    fields[def.path] = { value, confidence: Math.round((0.9 + r() * 0.1) * 100) / 100, method: "form_field", basis: "stated", source_document: application, snippet: "" };
  }
  const extraction: Extraction = {
    submission: data, fields, conflicts: [], missing_for_rating: [],
    documents: [{ filename: application, doc_type: "acord_125", parent: null, method: "form_fields" },
      ...(losses.length || r() < 0.7 ? [{ filename: `${slug}-loss-runs.pdf`, doc_type: "loss_run", parent: null, method: "claude" }] : [])],
    notes: [], warnings: ["Carried over from the quoting history: the broker's documents were not kept with this file; the extracted values were confirmed at intake."],
    claude: null,
  };

  // The underwriter's worksheet: the application's inputs, a mod on some files, a schedule on a third.
  const form: Record<string, string> = {
    class_code: code, gross_receipts: String(receipts), states: states.join(", "), home_state: home, occurrence_limit: "1000000", aggregate_limit: String(aggregate),
    deductible: deductible, residential_pct: String(residential), subcontracted_pct: String(subs), subcontractor_coi_required: "yes", max_height_ft: String(height), experience_mod: String(mod),
  };
  if (r() < 0.35) {
    const cats = Object.keys(RATIONALE);
    const n = between(r, 1, 2);
    const schedule: ScheduleItem[] = [];
    for (let k = 0; k < n; k++) {
      const cat = pick(r, cats);
      if (schedule.some((s) => s.category === cat)) continue;
      const credit = r() < 0.65;
      const pct = (credit ? -1 : 1) * between(r, 3, 8);
      schedule.push({ category: cat, pct, rationale: RATIONALE[cat][credit ? 0 : 1] });
    }
    for (const s of schedule) { form[`schedule.${s.category}.pct`] = String(s.pct); form[`schedule.${s.category}.rationale`] = s.rationale; }
  }
  const times = seedTimes(r, effective, now);
  const recent = now.getTime() - times.bound.getTime() < 45 * 86_400_000;
  return { name, fein, underwriter, effective, expiration: addYears(effective, 1), extraction, form, times, leaveOneSubjectivityOpen: recent && r() < 0.5 };
}

/** The whole set, deterministic for a given count and day. */
export function generateRisks(count: number, underwriters: string[], now: Date): SeedRisk[] {
  const r = rng(20260101 + count);
  const dates = effectiveDates(r, count, now);
  const taken = new Set<string>();
  return dates.map((effective, i) => buildRisk(r, i, effective, underwriters[(i + (r() < 0.2 ? 1 : 0)) % underwriters.length], now, taken));
}

// ---- running it --------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function waitForRating(maxMs: number): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const v = await activeRateVersion();
    if (v) return v;
    if (Date.now() - t0 > maxMs) throw new Error("the rating service didn't come up in time");
    await sleep(5_000);
  }
}

/** One file through the real pipeline at its back-dated times. Returns null when the insured already exists. */
export async function seedOne(risk: SeedRisk, active: string): Promise<{ policy_number: string; total: string } | null> {
  if ((await customerDb.query("SELECT 1 FROM insureds WHERE fein = $1", [risk.fein])).rowCount) return null;
  const uw = risk.underwriter;
  const t = risk.times;
  const { id } = await storeSubmission([], risk.extraction, uw, null, t.received);
  await acceptSubmission(id, uw, t.accepted);
  const sub = (await getSubmission(id))!;
  await saveAndRate(sub, risk.form, uw, t.rated);
  let ws = (await getWorksheet(id))!;
  for (const f of flagsFor(sub, ws)) {
    if (f.severity !== "refer") continue;
    await clearReferral(sub, f.code, CLEARANCE_NOTES[f.code] ?? "Reviewed with the underwriting manager; acceptable on the quoted terms.", uw, t.cleared);
  }
  ws = (await getWorksheet(id))!;
  const state = readiness(sub, ws, active);
  if (!state.ready) throw new Error(`not ready to quote (rated ${state.rated}, open ${state.openReferrals.map((f) => f.code).join(", ") || "none"})`);
  const subjectivities = suggestedSubjectivities(state.flags, sub.data);
  const q = await issueQuote(sub, { effective_date: risk.effective, expiration_date: risk.expiration, subjectivities: subjectivities.join("\n") }, uw, t.issued);
  const received = new Set(subjectivities.map((_, k) => k));
  if (risk.leaveOneSubjectivityOpen && subjectivities.length > 1) received.delete(subjectivities.length - 1);
  const p = await bindQuote(q.id, received, uw, t.bound);
  return { policy_number: p.policy_number, total: p.total };
}

/** The underwriters the history is spread over: the configured logins, else underwriter1-9 like the prior-system book. */
export function historyUnderwriters(env: Record<string, string | undefined>): string[] {
  const names = [...loadUsers(env).keys()];
  return names.length >= 2 ? names : Array.from({ length: 9 }, (_, i) => `underwriter${i + 1}`);
}

export async function seedHistory(count: number, env: Record<string, string | undefined> = process.env, now = new Date()) {
  const log = (m: string) => console.log(`[seed-history] ${m}`);
  const active = await waitForRating(5 * 60_000);
  const underwriters = historyUnderwriters(env);
  log(`seeding ${count} bound policies since ${HISTORY_START} across ${underwriters.join(", ")} on rates ${active}`);
  const risks = generateRisks(count, underwriters, now);
  let made = 0, present = 0, failed = 0;
  for (const [i, risk] of risks.entries()) {
    try {
      const made1 = await seedOne(risk, active);
      if (!made1) { present++; continue; }
      made++;
      log(`${i + 1}/${count} ${made1.policy_number} ${risk.name} · ${risk.underwriter} · bound ${risk.times.bound.toISOString().slice(0, 10)}, effective ${risk.effective} · $${Math.round(Number(made1.total)).toLocaleString("en-US")}`);
    } catch (err) {
      failed++;
      log(`${i + 1}/${count} FAILED ${risk.name}: ${(err as Error).message}`);
    }
  }
  log(`done: ${made} bound, ${present} already present, ${failed} failed`);
  return { made, present, failed };
}

/** SEED_HISTORY=<count>: seed in the background after startup (idempotent, so it may stay set). */
export function seedHistoryIfAsked(env: Record<string, string | undefined> = process.env): void {
  const n = Number(env.SEED_HISTORY ?? 0);
  if (!Number.isFinite(n) || n <= 0) return;
  void seedHistory(n, env).catch((err) => console.error("[seed-history] aborted:", err));
}
