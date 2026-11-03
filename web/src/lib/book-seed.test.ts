// The seeded book's loss experience, read from the migrations a database runs and put through the same
// summarizeBook as the desk, so what every login sees is checked without a database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addDays } from "./quote-terms.ts";
import { summarizeBook, type BookRow } from "./book-metrics.ts";

const migration = (path: string) => readFileSync(new URL(`../../migrations/${path}`, import.meta.url), "utf8");
const groups = (sql: string, pattern: RegExp) => [...sql.matchAll(pattern)];

type Seeded = {
  number: string; underwriter: string; code: string; days: number; seedClaims: number; seedOpen: number;
  premium: number; occurrence: number; debits: string[]; claims: number; incurred: number; open_claims: number;
};

const SEEDED_ON = "2026-11-03";
const book = new Map<string, Seeded>();
for (const [, number, underwriter, code, days, seedClaims, seedOpen] of groups(migration("policy/004_book_policies.sql"),
  /\('(GL-25-\d+)', '(?:[^']|'')*', '(underwriter\d)', '(\d+)', .*?CURRENT_DATE \+ -?\d+, CURRENT_DATE \+ (\d+), \d+, (\d), \d+, (\d), '\w+'\)/g)) {
  book.set(number, { number, underwriter, code, days: +days, seedClaims: +seedClaims, seedOpen: +seedOpen, premium: 0, occurrence: 0, debits: [], claims: 0, incurred: 0, open_claims: 0 });
}
for (const [, inputs, schedule, premium, number] of groups(migration("policy/005_book_rating_inputs.sql"),
  /rating_inputs = '(.*?)'::jsonb, schedule = '(.*?)'::jsonb, rate_version = '[^']*', premium = (\d+) WHERE policy_number = '([^']+)'/g)) {
  const p = book.get(number)!;
  p.premium = +premium;
  p.occurrence = JSON.parse(inputs).occurrence_limit;
  p.debits = JSON.parse(schedule).map((s: { category: string }) => s.category);
}
for (const [, claims, incurred, open, number] of groups(migration("policy/016_book_loss_experience.sql"),
  /claims = (\d+), incurred = (\d+), open_claims = (\d+) WHERE policy_number = '([^']+)'/g)) {
  Object.assign(book.get(number)!, { claims: +claims, incurred: +incurred, open_claims: +open });
}
const policies = [...book.values()];
const underwriters = [...new Set(policies.map((p) => p.underwriter))];

/** One desk's tile, `days` after the book was seeded: dates in the book are relative to that day. */
function desk(underwriter: string, days: number) {
  const rows: BookRow[] = policies.filter((p) => p.underwriter === underwriter).map((p) => ({
    effective_date: addDays(SEEDED_ON, p.days - 365), expiration_date: addDays(SEEDED_ON, p.days),
    class_code: p.code, class_description: "", premium: p.premium, incurred: p.incurred, open_claims: p.open_claims,
    renewal_status: "not_started", source: "prior system",
  }));
  return summarizeBook(rows, addDays(SEEDED_ON, days)).kpis;
}

test("the migrations cover the whole book", () => {
  assert.equal(policies.length, 103);
  assert.equal(underwriters.length, 9);
  assert.ok(policies.every((p) => p.premium > 0));
  assert.equal(groups(migration("policy/016_book_loss_experience.sql"), /^UPDATE book_policies/gm).length, 103);
});

test("every desk's book loss ratio reads about 25%, and underwriter1's reads 25% like the public screenshot", () => {
  for (const uw of underwriters) {
    const { lossRatio } = desk(uw, 0);
    assert.ok(lossRatio! >= 0.235 && lossRatio! <= 0.27, `${uw}: ${lossRatio}`);
  }
  assert.equal(Math.round(desk("underwriter1", 0).lossRatio! * 100), 25);
  const premium = policies.reduce((n, p) => n + p.premium, 0);
  const incurred = policies.reduce((n, p) => n + p.incurred, 0);
  assert.ok(Math.abs(incurred / (premium * 5) - 0.25) < 0.005, "the whole book");
});

test("the ratio holds as policies expire: dates are relative to when the book was seeded, and the tile only counts what's in force", () => {
  for (const uw of underwriters) {
    for (let day = 0; day <= 120; day++) {
      const { lossRatio } = desk(uw, day);
      assert.ok(lossRatio! >= 0.18 && lossRatio! <= 0.32, `${uw} on day ${day}: ${lossRatio}`);
    }
  }
  for (let day = 0; day <= 90; day++) {
    const shown = Math.round(desk("underwriter1", day).lossRatio! * 100);
    assert.ok(shown >= 24 && shown <= 26, `underwriter1 on day ${day}: ${shown}%`);
  }
});

test("each policy's losses make sense on its own", () => {
  for (const p of policies) {
    assert.equal(p.incurred > 0, p.claims > 0, `${p.number}: incurred with no claims, or claims with nothing incurred`);
    assert.ok(p.open_claims <= p.claims, `${p.number}: more open claims than claims`);
    assert.ok(p.open_claims >= p.seedOpen, `${p.number}: an open claim was closed`);
    if (p.claims) assert.ok(p.incurred / p.claims <= p.occurrence, `${p.number}: the average claim is over the occurrence limit`);
    if (p.debits.includes("loss_experience")) assert.ok(p.claims >= 2, `${p.number}: its schedule debit quotes two claims`);
  }
});

test("no two accounts on a desk show the same amount, which would read as made up", () => {
  for (const uw of underwriters) {
    const amounts = policies.filter((p) => p.underwriter === uw && p.incurred).map((p) => p.incurred);
    assert.equal(new Set(amounts).size, amounts.length, uw);
  }
});

test("a plausible book has claims still open, on every desk", () => {
  for (const uw of underwriters) {
    const mine = policies.filter((p) => p.underwriter === uw);
    const open = mine.reduce((n, p) => n + p.open_claims, 0);
    const claims = mine.reduce((n, p) => n + p.claims, 0);
    assert.ok(open >= 2 && open / claims >= 0.15 && open / claims <= 0.35, `${uw}: ${open} open of ${claims}`);
    assert.equal(desk(uw, 0).openClaims, open);
  }
});

test("a few accounts are much worse than the book, so the desk's red figure has something to show", () => {
  assert.ok(policies.filter((p) => p.incurred / (p.premium * 5) >= 0.65).length >= 4);
});

test("the heavier trades run worse than the lighter ones", () => {
  const ratio = (code: string) => {
    const of = policies.filter((p) => p.code === code);
    return of.reduce((n, p) => n + p.incurred, 0) / (of.reduce((n, p) => n + p.premium, 0) * 5);
  };
  for (const heavy of ["98677", "91583"]) for (const light of ["98304", "91342", "97050"]) {
    assert.ok(ratio(heavy) > ratio(light), `${heavy} ${ratio(heavy)} vs ${light} ${ratio(light)}`);
  }
});

test("the renewals the demo walks through don't gain a referral", () => {
  const redRock = book.get("GL-25-70001")!, palmHarbor = book.get("GL-25-70008")!;
  assert.equal(redRock.claims, redRock.seedClaims);
  assert.equal(redRock.open_claims, 0);
  assert.ok(palmHarbor.claims < 3, "LOSS_FREQUENCY starts at 3");
  assert.equal(palmHarbor.open_claims, 0);
});

test("the renewals' snapshots get the same totals as the policies", () => {
  const values = groups(migration("customer/007_book_renewal_losses.sql"), /\('(GL-25-\d+)', (\d+), (\d+), (\d+)\)/g);
  assert.equal(values.length, policies.length);
  for (const [, number, claims, incurred, open] of values) {
    const p = book.get(number)!;
    assert.deepEqual([+claims, +incurred, +open], [p.claims, p.incurred, p.open_claims], number);
  }
});
