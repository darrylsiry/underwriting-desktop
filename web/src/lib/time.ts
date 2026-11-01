/**
 * One display time zone for every on-screen timestamp (UX-006). Audit, history,
 * lists and the accounting page all format through here so the same event shows
 * the same wall-clock time, with the zone named, wherever it appears.
 */
export const DISPLAY_TIME_ZONE = process.env.DISPLAY_TZ || "America/New_York";

/** `Oct 31, 2026, 11:30 PM EDT` */
export const when = (d: Date | string) =>
  // Component options, not dateStyle/timeStyle: V8 rejects those together with timeZoneName ("Invalid option : option").
  new Date(d).toLocaleString("en-US", {
    timeZone: DISPLAY_TIME_ZONE, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

/** `Oct 31, 2026` — the one on-screen date format (UX-025). Accepts `YYYY-MM-DD` or a Date. */
export const whenDate = (d: Date | string) => {
  const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`) : new Date(d);
  return date.toLocaleDateString("en-US", { timeZone: typeof d === "string" ? "UTC" : DISPLAY_TIME_ZONE, dateStyle: "medium" });
};

/**
 * `Oct 31, 10:13 PM`: a compact timestamp for dense tables, in the display zone, with the year
 * only when it isn't this year (`Dec 31, 2025, 10:13 PM`). Give the cell `when()` as a title so
 * the full time and its zone are a hover away.
 */
export const whenShort = (d: Date | string, now: Date = new Date()) => {
  const date = new Date(d);
  const year = (x: Date) => x.toLocaleString("en-US", { timeZone: DISPLAY_TIME_ZONE, year: "numeric" });
  return date.toLocaleString("en-US", {
    timeZone: DISPLAY_TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    ...(year(date) === year(now) ? {} : { year: "numeric" as const }),
  });
};

/** ISO value for `<time dateTime>`. */
export const iso = (d: Date | string) => new Date(d).toISOString();
