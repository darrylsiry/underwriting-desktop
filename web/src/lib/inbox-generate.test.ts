import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { folderTitle, readInbox } from "./inbox-files.ts";
import { generateInboxSubmissions, inboxStamp, writeSubmission } from "./inbox-generate.ts";
import { buildSyntheticCase, rng } from "./synthetic-risk.ts";

const NOW = new Date("2026-10-30T14:32:10Z");

test("generated folders are stamped, listed newest first and titled without the stamp", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-gen-"));
  fs.mkdirSync(path.join(dir, "18-peach-state-flatwork"));
  fs.writeFileSync(path.join(dir, "18-peach-state-flatwork", "app.pdf"), "%PDF-1.4");
  const made = await generateInboxSubmissions(dir, 3, NOW);
  assert.equal(made.length, 3);
  for (const m of made) {
    assert.match(m.folder, /^20261030-1432-[a-z0-9-]+$/);
    assert.ok(m.files.length >= 1, `${m.folder} has documents`);
    assert.equal(folderTitle(m.folder).toLowerCase(), m.name.replace(/[.&]/g, "").replace(/\s+/g, " ").toLowerCase(), "the title is the insured's name");
  }
  const listed = readInbox(dir);
  assert.equal(listed.length, 4);
  assert.notEqual(listed[0].folder, "18-peach-state-flatwork", "generated ones sort first");
  assert.equal(inboxStamp(NOW), "20261030-1432");
  // a second run in the same minute avoids the names already there, so nothing collides
  const again = await generateInboxSubmissions(dir, 3, NOW);
  assert.equal(again.length, 3);
  const all = readInbox(dir).map((f) => f.folder);
  assert.equal(new Set(all).size, all.length, "no duplicate folders");
  assert.equal(all.length, 7);
});

test("a fillable application carries the ACORD-style field names and values ingestion reads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-gen-"));
  const c = buildSyntheticCase(rng(7), { effective: "2026-12-01", referrals: "none" }, new Set());
  const made = await writeSubmission(dir, c, "acord_fillable+loss_run", NOW);
  assert.deepEqual(made.files, [`${c.slug}-loss-run.pdf`, `${c.slug}-acord-application.pdf`]);
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(dir, made.folder, `${c.slug}-acord-application.pdf`)));
  const form = pdf.getForm();
  assert.equal(form.getTextField("NamedInsured_FullName_A").getText(), c.name);
  assert.equal(form.getTextField("GeneralLiability_Hazard_ClassCode_A").getText(), c.classCode);
  assert.equal(form.getTextField("GeneralLiability_Contractor_SubcontractorCertificateIndicator_A").getText(), "Y");
  assert.match(form.getTextField("GeneralLiability_Hazard_Exposure_A").getText() ?? "", /^\$[\d,]+$/);
  assert.equal(pdf.getPageCount(), 2);
  const names = form.getFields().map((f) => f.getName());
  assert.ok(names.includes("LossHistory_OccurrenceDate_A") && names.includes("Policy_EffectiveDate_A"));
});

test("a flattened application has no fields; a sparse email is plain text; an email with the loss run is multipart", async () => {
  const c = buildSyntheticCase(rng(11), { effective: "2026-12-15", referrals: "any" }, new Set());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-gen-"));
  const flat = await writeSubmission(dir, c, "acord_flattened+loss_run", NOW);
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(dir, flat.folder, `${c.slug}-application-scan.pdf`)));
  assert.equal(pdf.getForm().getFields().length, 0);

  const sparseDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-gen-"));
  const sparse = await writeSubmission(sparseDir, c, "broker_email_sparse", NOW);
  const eml = fs.readFileSync(path.join(sparseDir, sparse.folder, `${c.slug}-submission-email.eml`), "utf8");
  assert.match(eml, /^From: .+ <.+@.+\.example>\r\n/);
  assert.match(eml, new RegExp(`Subject: New submission - ${c.name.replace(/[.&]/g, "\\$&")} - Contractors GL`));
  assert.match(eml, /Content-Type: text\/plain/);
  assert.doesNotMatch(eml, /multipart/);

  const fullDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-gen-"));
  const full = await writeSubmission(fullDir, c, "acord_fillable+broker_email", NOW);
  assert.deepEqual(full.files, [`${c.slug}-acord-application.pdf`, `${c.slug}-submission-email.eml`], "the loss run travels inside the email");
  const mixed = fs.readFileSync(path.join(fullDir, full.folder, `${c.slug}-submission-email.eml`), "utf8");
  assert.match(mixed, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(mixed, /Content-Disposition: attachment; filename=".+-loss-run\.pdf"/);
  assert.match(mixed, /JVBERi0/, "a base64 PDF (%PDF-) is attached");
});

// ---- CR-128: a folder appears only once all its documents are written --------------------------

const aCase = () => buildSyntheticCase(rng(23), { effective: "2026-12-01", referrals: "none" }, new Set());

test("a write that fails part way leaves nothing in the inbox, and a retry works", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-gen-"));
  const realWrite = fs.writeFileSync;
  let writes = 0;
  const mock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (++writes === 2) {
      assert.deepEqual(readInbox(dir), [], "the first document is written but the inbox doesn't list the folder");
      throw new Error("disk full");
    }
    return realWrite(...args);
  });
  await assert.rejects(writeSubmission(dir, aCase(), "acord_fillable+loss_run", NOW), /disk full/);
  assert.equal(writes, 2);
  assert.deepEqual(readInbox(dir), []);
  assert.deepEqual(fs.readdirSync(dir), [], "the temp folder is gone too, so the minute's retry isn't blocked");

  mock.mock.restore();
  const made = await writeSubmission(dir, aCase(), "acord_fillable+loss_run", NOW);
  assert.deepEqual(fs.readdirSync(dir), [made.folder], "a successful run leaves the same folder as before");
  assert.deepEqual(readInbox(dir).map((f) => f.files.map((x) => x.name)), [made.files.toSorted()]);
});

test("while a folder is being written the inbox can't see it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-gen-"));
  const writing = writeSubmission(dir, aCase(), "acord_fillable+questionnaire", NOW);
  const during = fs.readdirSync(dir);
  assert.equal(during.length, 1);
  assert.match(during[0], /^\.tmp-20261030-1432-/);
  assert.deepEqual(readInbox(dir), []);
  const made = await writing;
  assert.deepEqual(fs.readdirSync(dir), [made.folder]);
  assert.equal(readInbox(dir).length, 1);
});

test("if another server finishes the same case first, its folder stands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-gen-"));
  const c = aCase();
  const first = await writeSubmission(dir, c, "broker_email_sparse", NOW);
  const email = path.join(dir, first.folder, `${c.slug}-submission-email.eml`);
  fs.writeFileSync(email, "the first server's copy");
  const second = await writeSubmission(dir, c, "broker_email_sparse", NOW);
  assert.equal(second.folder, first.folder);
  assert.deepEqual(fs.readdirSync(dir), [first.folder], "no temp folder left behind");
  assert.equal(fs.readFileSync(email, "utf8"), "the first server's copy");
});

test("a temp folder left by a stopped process is cleared once it's old, not while it may still be in use", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-gen-"));
  const stale = path.join(dir, ".tmp-20261030-0900-old-co-abcd1234");
  const fresh = path.join(dir, ".tmp-20261030-1430-new-co-abcd1234");
  for (const d of [stale, fresh]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, "app.pdf"), "%PDF-1.4"); }
  const old = new Date(NOW.getTime() - 2 * 3_600_000);
  fs.utimesSync(stale, old, old);
  const recent = new Date(NOW.getTime() - 60_000);
  fs.utimesSync(fresh, recent, recent);
  await generateInboxSubmissions(dir, 1, NOW);
  const left = fs.readdirSync(dir);
  assert.ok(!left.includes(path.basename(stale)));
  assert.ok(left.includes(path.basename(fresh)));
  assert.equal(readInbox(dir).length, 1, "neither is listed; only the new submission is");
});
