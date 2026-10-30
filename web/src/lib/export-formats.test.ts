import assert from "node:assert/strict";
import { test } from "node:test";
import { toCsv } from "./csv.ts";
import { crc32, toXlsx, zipStored } from "./xlsx.ts";

test("csv quotes what needs quoting and neutralizes formulas", () => {
  const csv = toCsv(["a", "b"], [["plain", 1234.5], ['say "hi", now', "=SUM(1)"], [null, new Date("2026-10-30T12:00:00Z")]]);
  assert.equal(csv, "﻿" + 'a,b\r\nplain,1234.50\r\n"say ""hi"", now",\'=SUM(1)\r\n,2026-10-30T12:00:00.000Z\r\n');
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

/** Read a stored zip's central directory: names and crcs, in order. */
function entries(zip: Uint8Array): { name: string; crc: number; size: number }[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50, "end of central directory");
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, "central header");
    const nameLen = dv.getUint16(p + 28, true);
    out.push({ name: new TextDecoder().decode(zip.slice(p + 46, p + 46 + nameLen)), crc: dv.getUint32(p + 16, true), size: dv.getUint32(p + 24, true) });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

test("zip entries carry the right names, sizes and crcs", () => {
  const enc = new TextEncoder();
  const zip = zipStored([["a.txt", enc.encode("hello")], ["dir/b.txt", enc.encode("")]]);
  assert.deepEqual(entries(zip), [
    { name: "a.txt", crc: crc32(enc.encode("hello")), size: 5 },
    { name: "dir/b.txt", crc: 0, size: 0 },
  ]);
  assert.equal(new TextDecoder().decode(zip.slice(30 + 5, 30 + 5 + 5)), "hello", "first local entry's data follows its header");
});

test("xlsx has the parts Excel needs, numbers as numbers and strings escaped", () => {
  const xlsx = toXlsx("Sub-ledger", ["Account", "Debit"], [["Premiums & fees <net>", 38863], ["Written premium", 0]]);
  assert.deepEqual(entries(xlsx).map((e) => e.name), [
    "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml",
  ]);
  const text = new TextDecoder().decode(xlsx);
  assert.match(text, /<c r="B2" s="2"><v>38863<\/v><\/c>/);
  assert.match(text, /Premiums &amp; fees &lt;net&gt;/);
  assert.match(text, /<c r="A1" t="inlineStr" s="1">/);
  assert.match(text, /<sheet name="Sub-ledger" sheetId="1" r:id="rId1"\/>/);
});
