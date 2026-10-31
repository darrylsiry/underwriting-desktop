import assert from "node:assert/strict";
import test from "node:test";
import { when, whenDate } from "./time.ts";

// UX-006: every on-screen timestamp carries the display zone's name.
test("when renders the display zone with its abbreviation", () => {
  const s = when(new Date("2026-11-01T03:30:00Z"));
  assert.match(s, /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M [A-Z]{2,4}$/);
  assert.ok(s.endsWith("EDT") || s.endsWith("EST") || process.env.DISPLAY_TZ, s);
});

// UX-025: one on-screen date format; a YYYY-MM-DD string never shifts a day.
test("whenDate renders Dec 1, 2026 for an ISO date string", () => {
  assert.equal(whenDate("2026-12-01"), "Dec 1, 2026");
});
