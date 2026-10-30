// CSV the way spreadsheets expect it: RFC 4180 quoting, CRLF, a UTF-8 BOM so Excel reads accents.
// Pure module for node:test.

export type Cell = string | number | boolean | null | undefined | Date;

function cell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "boolean") return v ? "true" : "false";
  // A leading =, + or @ would be run as a formula by some spreadsheets; neutralize it.
  const s = /^[=+@]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
