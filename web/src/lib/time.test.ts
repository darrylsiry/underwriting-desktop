import assert from "node:assert/strict";
import test from "node:test";
import { when, whenDate, whenShort } from "./time.ts";

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
