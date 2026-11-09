import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, addYears, formsFor, parseSubjectivities, producerFields, producerLines, producerOf, quoteLimits, quotePeriod, suggestedSubjectivities, quoteFormEffective, quotedFactChanges } from "./quote-terms.ts";
import { buildSyntheticCase, rng } from "./synthetic-risk.ts";
import type { Flag } from "./referrals.ts";
import type { SubmissionData } from "./submission.ts";

const flag = (code: string): Flag => ({ code, severity: "warn", title: code, detail: "" });
const data = (applicant: Record<string, string>) => ({ applicant } as unknown as SubmissionData);

test("subjectivities follow the file's gaps", () => {
  assert.deepEqual(
    suggestedSubjectivities([flag("NO_LOSS_RUNS"), flag("CLASS_INFERRED")], data({ street: "", zip: "", fein: "86-1" })),
    [
      "Signed and dated application",
      "Five years of currently valued loss runs, satisfactory to the company",
      "Confirmation of operations and class code",
      "Complete named insured details (street, zip)",
    ],
  );
  assert.deepEqual(suggestedSubjectivities([], data({ street: "1 Main", zip: "1", fein: "1" })), ["Signed and dated application"]);
  // A younger business is asked for all of its years (CR-062).
  const young = { applicant: { street: "1 Main", zip: "1", fein: "1", years_in_business: 2 } } as unknown as SubmissionData;
  assert.deepEqual(suggestedSubjectivities([flag("NO_LOSS_RUNS")], young),
    ["Signed and dated application", "Currently valued loss runs for all 2 years in business, satisfactory to the company"]);
});

test("dates", () => {
  assert.equal(addYears("2026-11-01", 1), "2027-11-01");
  assert.equal(addDays("2026-12-15", 30), "2027-01-14");
});

test("subjectivity lines are cleaned", () => {
  assert.deepEqual(parseSubjectivities("1. Signed app\n- Loss runs\n\n• COIs \n5 years of loss runs\n2) Survey"),
    ["Signed app", "Loss runs", "COIs", "5 years of loss runs", "Survey"]);
});

test("forms follow the exposures", () => {
  const base = { states: ["TX"], subcontracted_pct: 0, residential_pct: 0, class_code: "92215" };
  assert.equal(formsFor(base).length, 4);
  const ny = formsFor({ states: ["NY", "NJ"], subcontracted_pct: 75, residential_pct: 20, class_code: "91583" });
  assert.ok(ny.some((f) => f.startsWith("Action Over")) && ny.some((f) => f.startsWith("Independent Contractors")));
});

test("a quote's period is one year, whatever else is typed (CR-113)", () => {
  assert.deepEqual(quotePeriod({ effective_date: "2026-11-01", expiration_date: "2027-11-01" }), { effective: "2026-11-01", expiration: "2027-11-01" });
  assert.deepEqual(quotePeriod({ effective_date: " 2026-11-01 ", expiration_date: "" }), { effective: "2026-11-01", expiration: "2027-11-01" });
  for (const expiration_date of ["2029-11-01", "2026-12-01", "2027-10-31", "2027-11-02", "2026-11-01", "2026-10-01"]) {
    assert.throws(() => quotePeriod({ effective_date: "2026-11-01", expiration_date }), /^Error: Expiration must be Nov 1, 2027/, expiration_date);
  }
});

test("dates that aren't on the calendar are refused before anything is rated (CR-019)", () => {
  assert.throws(() => quotePeriod({ effective_date: "2026-02-30", expiration_date: "" }), /^Error: Effective date: use YYYY-MM-DD/);
  assert.throws(() => quotePeriod({ effective_date: "12/1/2026", expiration_date: "" }), /^Error: Effective date/);
  assert.throws(() => quotePeriod({ effective_date: "", expiration_date: "" }), /^Error: Effective date/);
  assert.throws(() => quotePeriod({ effective_date: "2026-03-01", expiration_date: "2027-02-30" }), /^Error: Expiration: use YYYY-MM-DD/);
});

test("the leap day: what the forms pre-fill, renewals roll to and seeding sets is what's accepted (CR-113)", () => {
  assert.equal(addYears("2028-02-29", 1), "2029-03-01");
  assert.deepEqual(quotePeriod({ effective_date: "2028-02-29", expiration_date: "2029-03-01" }), { effective: "2028-02-29", expiration: "2029-03-01" });
  assert.throws(() => quotePeriod({ effective_date: "2028-02-29", expiration_date: "2029-02-28" }), /^Error: Expiration must be Mar 1, 2029/);
  // Every effective date over a leap cycle, and the renewal that follows it (renewals effective on the expiration, one year on).
  const day = new Date("2026-01-01T00:00:00Z");
  for (let i = 0; i < 366 * 4; i++, day.setUTCDate(day.getUTCDate() + 1)) {
    const effective = day.toISOString().slice(0, 10);
    const expiration = addYears(effective, 1);
    assert.equal(quotePeriod({ effective_date: effective, expiration_date: expiration }).expiration, expiration);
    assert.equal(quotePeriod({ effective_date: expiration, expiration_date: addYears(expiration, 1) }).effective, expiration);
  }
  // The generated data's stated expiration is a real date too.
  const { data } = buildSyntheticCase(rng(1), { effective: "2028-02-29", referrals: "none" }, new Set());
  assert.equal(data.policy.expiration_date, "2029-03-01");
});

test("every limit on a quote is one the underwriter saw on the worksheet (CR-024)", () => {
  assert.deepEqual(quoteLimits({ occurrence_limit: 1_000_000, aggregate_limit: 4_000_000 }).map((l) => l.amount), [1_000_000, 4_000_000, 4_000_000]);
});

test("producer details are read by name, not by position in the display lines (CR-125)", () => {
  const noContact = producerFields({ agency: "Sunbelt Brokers", contact: "", email: "a@b.example", phone: "555-0100" });
  assert.deepEqual(producerLines(noContact), ["Sunbelt Brokers", "a@b.example", "555-0100"]);
  assert.equal(producerOf({ producer: producerLines(noContact), producer_fields: noContact }).contact, "");
  const noAgency = producerFields({ agency: null, contact: "Pat Lee", email: "a@b.example", phone: null });
  assert.deepEqual(producerLines(noAgency), ["Pat Lee", "a@b.example"]);
  assert.equal(producerOf({ producer: producerLines(noAgency), producer_fields: noAgency }).agency, "");
  // A quote from before the fix has only the lines, and a prior-system policy only an agency.
  assert.deepEqual(producerOf({ producer: ["Sunbelt Brokers", "Pat Lee", "a@b.example"] }), { agency: "Sunbelt Brokers", contact: "Pat Lee", email: "", phone: "" });
  assert.equal(producerOf({ producer: ["Sunbelt Brokers"] }).contact, "");
  assert.equal(producerOf({}).agency, "");
});

test("a quote form starts from the intake's date only when it was corrected after the latest quote (CR-181)", () => {
  const latest = { effective_date: "2026-12-01", issued_at: new Date("2026-11-05T12:00:00Z") };
  const corrected = (at: string) => ({ action: "submission.field_corrected", occurred_at: new Date(at), before: { "policy.effective_date": "2026-12-01" } });
  assert.equal(quoteFormEffective(undefined, "2027-01-01", []), "2027-01-01");
  assert.equal(quoteFormEffective(latest, "2027-01-01", []), "2026-12-01", "a quote typed with another date keeps it");
  assert.equal(quoteFormEffective(latest, "2027-01-01", [corrected("2026-11-04T12:00:00Z")]), "2026-12-01", "corrected before the quote");
  assert.equal(quoteFormEffective(latest, "2027-01-01", [corrected("2026-11-06T12:00:00Z")]), "2027-01-01");
  const otherField = { action: "submission.field_corrected", occurred_at: new Date("2026-11-06T12:00:00Z"), before: { "applicant.name": "X" } };
  assert.equal(quoteFormEffective(latest, "2027-01-01", [otherField]), "2026-12-01");
});

test("what a quote froze about the insured and producer, against the file now (UX-081)", () => {
  const data = { applicant: { street: "1 Main St", city: "Austin", state: "TX", zip: "78701" }, producer: { agency: "Copper State", contact: "Lena Ruiz" } } as never;
  const quoted = { insured_name: "Desert Bloom LC", terms: { insured_address: ["1 Main St", "Austin, TX 78701"], producer: ["Copper State", "Lena Ruiz"] } };
  assert.deepEqual(quotedFactChanges(quoted, { applicant_name: "Desert Bloom LC", data }), []);
  assert.deepEqual(quotedFactChanges(quoted, { applicant_name: "Desert Bloom LLC", data }), [{ label: "Named insured", from: "Desert Bloom LC", to: "Desert Bloom LLC" }]);
});
