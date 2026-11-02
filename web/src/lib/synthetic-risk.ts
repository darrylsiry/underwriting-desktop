// Fictitious E&S contractors GL risks, built deterministically from a seed: the vocabulary the
// prior-system book, the seeded history and the generated inbox submissions all share, so the demo's
// insureds, producers and trades read as one portfolio. Pure module (type-only imports) for node:test.
import { addYears } from "./quote-terms.ts";
import { ROOFING_CLASSES } from "./referrals.ts";
import type { Loss, SubmissionData } from "./submission";

export type Rng = () => number;

/** mulberry32: small, deterministic, good enough for demo data. */
export function rng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export const between = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export const weighted = (r: Rng, items: [string, number][]) => {
  let n = r() * items.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of items) { n -= w; if (n <= 0) return k; }
  return items[items.length - 1][0];
};
export const roundTo = (n: number, to: number) => Math.round(n / to) * to;
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

type ClassDef = { desc: string; trades: string[]; receipts: [number, number]; residential: [number, number]; height: [number, number]; subs: [number, number]; ops: string; losses: string[] };
export const CLASSES: Record<string, ClassDef> = {
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
export const BASE_RATE: Record<string, number> = { "91342": 9.4, "91560": 7.3, "91583": 11.5, "92215": 6.5, "97050": 5.1, "98304": 8.2, "98482": 7.5, "98677": 22 };
const CLASS_WEIGHTS: [string, number][] = [["91583", 20], ["92215", 16], ["98482", 15], ["91560", 12], ["97050", 12], ["98304", 10], ["91342", 9], ["98677", 6]];

// States the rate tables carry a territory for. NY always refers (Labor Law), so it only appears when referrals are wanted.
const STATE_WEIGHTS: Record<string, number> = { TX: 18, FL: 16, AZ: 12, CO: 11, GA: 9, NV: 8, WA: 8, SC: 7, NJ: 6, WY: 5 };
const NEIGHBORS: Record<string, string[]> = { TX: ["TX"], FL: ["FL", "GA"], GA: ["GA", "SC"], SC: ["SC", "GA"], AZ: ["AZ", "NV"], NV: ["NV", "AZ"], CO: ["CO", "WY"], WY: ["WY", "CO"], WA: ["WA"], NJ: ["NJ"], NY: ["NY", "NJ"] };
const PLACES: Record<string, string[]> = {
  TX: ["Brazos", "Hill Country", "Gulf Plains", "Pecos", "Trinity", "Lone Star"], FL: ["Suncoast", "Palm Harbor", "Everglades", "Gulf Breeze", "Treasure Coast"],
  GA: ["Chattahoochee", "Savannah River", "Blue Ridge", "Peachtree"], SC: ["Palmetto", "Lowcountry", "Congaree"], AZ: ["Saguaro", "Mesa Verde", "Red Rock", "Sonoran", "Copper Canyon"],
  NV: ["Silver State", "High Desert", "Tahoe", "Sierra Vista"], CO: ["Summit", "Pikes Peak", "Front Range", "Aspen Grove"], WY: ["Wind River", "Teton", "Bighorn"],
  WA: ["Cascade", "Olympic", "Puget", "Rainier"], NJ: ["Garden State", "Pinelands", "Raritan"], NY: ["Hudson", "Empire", "Adirondack", "Finger Lakes"],
};
const CITIES: Record<string, [string, string][]> = {
  TX: [["Houston", "770"], ["Dallas", "752"], ["Austin", "787"], ["San Antonio", "782"], ["Fort Worth", "761"]], FL: [["Tampa", "336"], ["Orlando", "328"], ["Jacksonville", "322"], ["Fort Myers", "339"], ["Sarasota", "342"]],
  GA: [["Atlanta", "303"], ["Savannah", "314"], ["Macon", "312"]], SC: [["Charleston", "294"], ["Greenville", "296"], ["Columbia", "292"]], AZ: [["Phoenix", "850"], ["Tucson", "857"], ["Mesa", "852"], ["Chandler", "852"]],
  NV: [["Las Vegas", "891"], ["Reno", "895"], ["Henderson", "890"]], CO: [["Denver", "802"], ["Colorado Springs", "809"], ["Fort Collins", "805"]], WY: [["Cheyenne", "820"], ["Casper", "826"]],
  WA: [["Seattle", "981"], ["Tacoma", "984"], ["Spokane", "992"]], NJ: [["Newark", "071"], ["Edison", "088"], ["Cherry Hill", "080"]], NY: [["Albany", "122"], ["Buffalo", "142"], ["Yonkers", "107"]],
};
const STREETS = ["Industrial Blvd", "Commerce Dr", "Enterprise Way", "Frontage Rd", "Mill St", "Airport Rd", "Trade Center Pkwy", "Ranch Rd", "Harbor View Dr", "Cedar Ave", "Depot St", "Quarry Ln"];
const SUFFIXES: [string, string][] = [["LLC", "LLC"], ["Inc.", "Corporation"], ["Corp.", "Corporation"], ["Co.", "Corporation"], ["LLC", "LLC"]];
export const PRODUCERS = [
  "Alamo Specialty Brokers", "Big Sky Brokerage Group", "Catskill Specialty Agency", "Copper State Insurance Group", "Coral Gables Excess & Surplus",
  "Desert Peak Insurance Services", "Evergreen Wholesale Brokers", "Front Range Wholesale", "Gulf Coast E&S Partners", "Palmetto Specialty Underwriters",
  "Southern Risk Advisors", "Lone Star Specialty Brokers",
];
const FIRST = ["Maria", "James", "Priya", "Daniel", "Aisha", "Robert", "Elena", "Marcus", "Hannah", "Luis", "Grace", "Tomas", "Nadia", "Kevin", "Olivia", "Samir"];
const LAST = ["Alvarez", "Chen", "Patel", "Okafor", "Nguyen", "Brooks", "Romero", "Kowalski", "Haddad", "Fischer", "Delgado", "Murphy", "Sato", "Lindqvist", "Ortega", "Reyes"];
const PRIOR_CARRIERS = ["Westbridge Specialty", "Harbor Point E&S", "Ridgeline Excess", "Meridian Surplus Lines", "Cobalt Specialty", "Northgate Underwriters"];

/**
 * Which referral rules a risk may trip. "none": inside every authority limit. "clearable": only the
 * ones an underwriter clears with a note (roofing, work at height). "any": also New York, limits
 * above authority, uninsured subs, receipts above authority and loss frequency, for intake demos.
 */
export type ReferralMix = "none" | "clearable" | "any";

export type SyntheticCase = {
  name: string; slug: string; fein: string; classCode: string; home: string;
  /** The submission in the canonical schema (what an extraction produces). */
  data: SubmissionData;
  /** Which rule the case was built to trip, if any (so a demo script can say what to expect). */
  trips: string | null;
};

export function buildSyntheticCase(r: Rng, o: { effective: string; referrals: ReferralMix }, taken: Set<string>): SyntheticCase {
  let trips: string | null = null;
  if (o.referrals === "clearable" && r() < 0.06) trips = "HEIGHT";
  if (o.referrals === "any" && r() < 0.35) trips = pick(r, ["NY_LABOR_LAW", "HIGH_LIMITS", "UNINSURED_SUBS", "LARGE_ACCOUNT", "LOSS_FREQUENCY", "HEIGHT", "ROOFING"]);

  const code = trips === "ROOFING" ? ROOFING_CLASSES[0] : weighted(r, CLASS_WEIGHTS);
  const c = CLASSES[code];
  if (trips === null && ROOFING_CLASSES.includes(code) && o.referrals !== "none") trips = "ROOFING";
  const home = trips === "NY_LABOR_LAW" ? "NY" : weighted(r, Object.entries(STATE_WEIGHTS));
  let name = "";
  for (let tries = 0; tries < 20 && (!name || taken.has(name)); tries++) {
    name = `${pick(r, PLACES[home])} ${pick(r, c.trades)} ${pick(r, SUFFIXES)[0]}`;
  }
  taken.add(name);
  const entityType = (SUFFIXES.find(([s]) => name.endsWith(s)) ?? SUFFIXES[0])[1];
  const [city, zipPrefix] = pick(r, CITIES[home]);
  const states = r() < 0.6 ? [home] : [...new Set([home, ...NEIGHBORS[home]])];
  let receipts = roundTo(Math.exp(Math.log(c.receipts[0]) + r() * (Math.log(c.receipts[1]) - Math.log(c.receipts[0]))), 10_000);
  if (trips === "LARGE_ACCOUNT") receipts = roundTo(16_000_000 + r() * 9_000_000, 100_000);
  const years = between(r, 3, 38);
  const residential = between(r, c.residential[0], c.residential[1]);
  let subs = between(r, c.subs[0], c.subs[1]);
  let coi = true;
  if (trips === "UNINSURED_SUBS") { subs = between(r, 25, 45); coi = false; }
  const height = trips === "HEIGHT" ? between(r, 50, 75) : between(r, c.height[0], c.height[1]);
  const occurrence = trips === "HIGH_LIMITS" ? 2_000_000 : 1_000_000;
  const aggregate = trips === "HIGH_LIMITS" ? 4_000_000 : r() < 0.2 ? 3_000_000 : 2_000_000;
  const deductible = Number(weighted(r, [["0", 1], ["1000", 2], ["2500", 4], ["5000", 4], ["10000", 2]]));
  const fein = `${between(r, 20, 99)}-${String(1_000_000 + Math.floor(r() * 8_999_999))}`;
  const contact = `${pick(r, FIRST)} ${pick(r, LAST)}`;
  const agency = pick(r, PRODUCERS);
  const lossCount = trips === "LOSS_FREQUENCY" ? between(r, 3, 4) : Number(weighted(r, [["0", 5], ["1", 3], ["2", 2]]));
  const losses: Loss[] = Array.from({ length: lossCount }, (_, k) => {
    const incurred = roundTo(2_000 + r() * (k === 0 ? 58_000 : 25_000), 100);
    const year = Number(o.effective.slice(0, 4)) - between(r, 1, 4);
    return { date: `${year}-${String(between(r, 1, 12)).padStart(2, "0")}-${String(between(r, 1, 28)).padStart(2, "0")}`, description: pick(r, c.losses), incurred, status: r() < 0.15 && incurred < 60_000 ? "Open" : "Closed" };
  });
  const priorPremium = roundTo((receipts / 1000) * BASE_RATE[code] * (0.9 + r() * 0.25), 100);
  const slug = slugify(name);
  const expiration = addYears(o.effective, 1);

  const data = {
    applicant: { name, dba: "", street: `${between(r, 100, 9800)} ${pick(r, STREETS)}`, city, state: home, zip: `${zipPrefix}${String(between(r, 10, 99))}`, fein, entity_type: entityType, years_in_business: years, website: r() < 0.6 ? `www.${slug.replace(/-(llc|inc|corp|co)$/, "")}.example` : "" },
    operations: { description: c.ops, class_code: code, states, gross_receipts: receipts, payroll: roundTo(receipts * (0.24 + r() * 0.12), 1000), employees: Math.max(3, Math.round(receipts / 180_000)), subcontracted_pct: subs, subcontractor_coi_required: coi, residential_pct: residential, new_construction_pct: between(r, 10, 60), max_height_ft: height, wrap_up_projects: r() < 0.1 },
    policy: { effective_date: o.effective, expiration_date: expiration, occurrence_limit: occurrence, aggregate_limit: aggregate, products_aggregate_limit: aggregate, deductible },
    producer: { agency, contact, email: `${contact.toLowerCase().replace(" ", ".")}@${slugify(agency).replace(/-/g, "")}.example`, phone: `(${between(r, 201, 989)}) 555-01${String(between(r, 10, 99))}` },
    prior: { carrier: pick(r, PRIOR_CARRIERS), premium: priorPremium },
    loss_history: losses,
  } as unknown as SubmissionData;
  return { name, slug, fein, classCode: code, home, data, trips };
}
