import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerJson, type JsonJournal } from "./gl-export-json.ts";

const journal: JsonJournal = {
  journal_no: "JE-000002", posted_at: new Date("2026-10-30T18:51:42Z"), accounting_period: "2026-10", transaction_type: "renewal",
  description: "Renewal bound: GL-26-00002, Red Rock Electrical Contractors Corp. (11/13/2026 to 11/13/2027)",
  policy_id: "p1", policy_number: "GL-26-00002", insured_name: "Red Rock Electrical Contractors Corp.", effective_date: "2026-11-13",
  expiration_date: "2027-11-13", quote_ref: "Q-2026-0002 v1", submission_id: "s1", submission_ref: "SUB-0005", underwriter: "underwriter1",
  producer: "Front Range Wholesale", source_action: "policy.bound", correlation_id: "c1", export_batch: null,
  lines: [
    { line_no: 1, account_code: "1200", account_name: "Premiums receivable", debit: "38863.00", credit: "0.00" },
    { line_no: 2, account_code: "4100", account_name: "Written premium - E&S contractors GL", debit: "0.00", credit: "37481.00" },
    { line_no: 3, account_code: "4200", account_name: "Policy fee income", debit: "0.00", credit: "250.00" },
    { line_no: 4, account_code: "2300", account_name: "Surplus lines tax payable", debit: "0.00", credit: "1132.00" },
  ],
};

test("json export carries batch, filter, totals and nested journals with numbers as numbers", () => {
  const text = ledgerJson([journal], { journals: 1, debit: 38863, credit: 38863, premium: 37481, fee: 250, tax: 1132, receivable: 38863 }, {
    batch: "GLX-20261030-003", generatedAt: new Date("2026-10-30T20:00:00Z"), generatedBy: "underwriter1", origin: "https://uwdesk-web.fly.dev",
    timeZone: "America/New_York", from: "2026-10-01", to: "2026-10-31", transactionType: null,
  });
  const doc = JSON.parse(text);
  assert.equal(doc.batch, "GLX-20261030-003");
  assert.deepEqual(doc.filter, { posting_date_from: "2026-10-01", posting_date_to: "2026-10-31", transaction_type: null });
  assert.equal(doc.totals.lines, 4);
  assert.equal(doc.totals.written_premium, 37481);
  const j = doc.journals[0];
  assert.equal(j.export_batch, "GLX-20261030-003", "an unpushed journal takes this batch");
  assert.equal(j.posted_at, "2026-10-30T18:51:42.000Z");
  assert.equal(j.policy.url, "https://uwdesk-web.fly.dev/policies/p1");
  assert.equal(j.source.audit_url, "https://uwdesk-web.fly.dev/audit?submission=s1&correlation=c1");
  assert.deepEqual(j.lines[0], { line_no: 1, account_code: "1200", account_name: "Premiums receivable", debit: 38863, credit: 0 });
  assert.equal(j.lines.reduce((n: number, l: { debit: number }) => n + l.debit, 0), j.lines.reduce((n: number, l: { credit: number }) => n + l.credit, 0));
  assert.ok(text.endsWith("\n"));
});

test("a journal pushed earlier keeps its batch", () => {
  const doc = JSON.parse(ledgerJson([{ ...journal, export_batch: "GLX-20261030-001" }], { journals: 1, debit: 0, credit: 0, premium: 0, fee: 0, tax: 0, receivable: 0 }, {
    batch: "GLX-20261030-003", generatedAt: new Date(), generatedBy: "x", origin: "", timeZone: "UTC", from: null, to: null, transactionType: "renewal",
  }));
  assert.equal(doc.journals[0].export_batch, "GLX-20261030-001");
  assert.equal(doc.filter.transaction_type, "renewal");
});
