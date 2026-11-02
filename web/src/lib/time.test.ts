import assert from "node:assert/strict";
import test from "node:test";
import { fromInput } from "./submission.ts";
import { isIsoDate, todayIso, when, whenDate, whenShort } from "./time.ts";

// UX-006: every on-screen timestamp carries the display zone's name.
test("when renders the display zone with its abbreviation", () => {
  const s = when(new Date("2026-11-01T03:30:00Z"));
  assert.match(s, /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M [A-Z]{2,4}$/);
  assert.ok(s.endsWith("EDT") || s.endsWith("EST") || process.env.DISPLAY_TZ, s);
});

// The sign-ins tables: month, day and time; the year only when it isn't this year; no zone (it's in the title).
test("whenShort drops this year and the zone, and keeps another year", () => {
  const now = new Date("2026-11-01T02:00:00Z");
  const same = whenShort(new Date("2026-10-31T14:13:00Z"), now);
  assert.match(same, /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/, same);
  if (!process.env.DISPLAY_TZ) assert.equal(same, "Oct 31, 10:13 AM");
  const older = whenShort(new Date("2025-06-15T16:00:00Z"), now);
  assert.match(older, /^[A-Z][a-z]{2} \d{1,2}, 2025, \d{1,2}:\d{2} [AP]M$/, older);
});

// UX-025: one on-screen date format; a YYYY-MM-DD string never shifts a day.
test("whenDate renders Dec 1, 2026 for an ISO date string", () => {
  assert.equal(whenDate("2026-12-01"), "Dec 1, 2026");
});

// CR-035: an evening bind on Dec 31 Eastern is still Dec 31 (and 2026), though UTC has moved on to next year.
test("todayIso is the books' date, not the UTC date", () => {
  const evening = new Date("2027-01-01T04:30:00Z");   // 23:30 on Dec 31 in New York
  assert.equal(evening.toISOString().slice(0, 10), "2027-01-01");
  assert.equal(todayIso(evening), "2026-12-31");
  assert.equal(todayIso(new Date("2026-07-04T12:00:00Z")), "2026-07-04");
});

// CR-068: these would otherwise reach a Postgres ::date cast and come back as a 500.
test("isIsoDate takes real calendar dates only", () => {
  for (const good of ["2026-02-28", "2028-02-29", "2026-12-31"]) assert.equal(isIsoDate(good), true, good);
  for (const bad of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "0000-01-01", "2026-2-3", "yesterday", "", undefined, null, ["2026-01-01"]]) {
    assert.equal(isIsoDate(bad), false, String(bad));
  }
});

test("an intake date field refuses a date that isn't on the calendar (CR-068)", () => {
  const field = { path: "policy.effective_date", label: "Effective", type: "date" as const };
  assert.equal(fromInput(field, "2026-02-28"), "2026-02-28");
  assert.throws(() => fromInput(field, "2026-02-30"), /Effective: use YYYY-MM-DD/);
});
