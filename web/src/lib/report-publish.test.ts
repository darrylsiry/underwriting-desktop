import assert from "node:assert/strict";
import { test } from "node:test";
import { bearerOk, checkPublish, ledgerTime } from "./report-publish.ts";

const WRITTEN = "2026-11-02T20:12:00.000Z";
const file = (name: string, text: string) => ({ name, text, written_at: WRITTEN });
const LEDGER = file("AGENT_LEDGER.json", JSON.stringify({ version: 1, updatedAt: WRITTEN, runs: [], items: {} }));
const refused = (files: unknown) => {
  const r = checkPublish({ files });
  assert.ok("error" in r, "should be refused");
  return r.error;
};

test("only the token passes, as a Bearer token", () => {
  assert.equal(bearerOk("Bearer s3cret", "s3cret"), true);
  for (const h of ["Bearer wrong", "Bearer s3cret2", "Bearer ", "s3cret", "bearer s3cret", "Basic czNjcmV0", null]) assert.equal(bearerOk(h, "s3cret"), false, String(h));
});

test("a whole set passes: ledger, reports and mockups", () => {
  const files = [LEDGER, file("CODE_REVIEW.md", "# Code review: x\n"), file("UX_REVIEW.md", "# UX review: x\n"), file("UAT_REPORT.md", "# UAT report: x\n"), file("ux-mockups/UX-068.html", "<p>x</p>")];
  assert.deepEqual(checkPublish({ files }), { files });
});

test("the security report can't be published, even correctly titled (CR-097)", () => {
  assert.match(refused([LEDGER, file("SECURITY_REVIEW.md", "# Security review: x\n")]), /SECURITY_REVIEW\.md can't be published/);
});

test("anything outside the list is refused, however it is spelled", () => {
  for (const name of ["../.env", "/etc/passwd", "docs/CODE_REVIEW.md", "ux-mockups/../../x.html", "ux-mockups/UX-1.html", "ux-mockups/UX-068.html.exe", "notes.md"]) {
    assert.match(refused([LEDGER, file(name, "x")]), /can't be published/, name);
  }
});

test("a report caught mid-write or filed under the wrong name is refused", () => {
  assert.match(refused([LEDGER, file("CODE_REVIEW.md", "half a repo")]), /isn't that agent's report/);
  assert.match(refused([LEDGER, file("CODE_REVIEW.md", "# UX review: x\n")]), /isn't that agent's report/);
  assert.match(refused([LEDGER, file("CODE_REVIEW.md", "  \n")]), /is empty/);
});

test("a bad ledger, a missing ledger or a bad file refuses the whole set", () => {
  assert.match(refused([file("AGENT_LEDGER.json", "{")]), /isn't valid JSON/);
  assert.match(refused([file("AGENT_LEDGER.json", '{"version":1}')]), /isn't a ledger/);
  assert.match(refused([file("CODE_REVIEW.md", "# Code review: x\n")]), /needs AGENT_LEDGER\.json/);
  assert.match(refused([LEDGER, LEDGER]), /appears twice/);
  assert.match(refused([LEDGER, file("ux-mockups/UX-068.html", "a\u0000b")]), /holds a NUL/);
  assert.match(refused([LEDGER, { name: "ux-mockups/UX-068.html", text: "x", written_at: "soon" }]), /unreadable written_at/);
  assert.match(refused([{ name: "x" }]), /needs a name, text and written_at/);
  for (const payload of [null, {}, { files: "x" }]) assert.ok("error" in checkPublish(payload));
});

test("a ledger dates the set; one that can't say counts as oldest", () => {
  assert.equal(ledgerTime(LEDGER.text), Date.parse(WRITTEN));
  for (const j of [null, undefined, "", "{", "{}", '{"updatedAt":"soon"}']) assert.equal(ledgerTime(j), 0, String(j));
});
