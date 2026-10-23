import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contentTypeFor, folderTitle, inboxDir, isSafeName, loadFolder, readInbox } from "./inbox-files.ts";

function dropFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
  fs.mkdirSync(path.join(dir, "01-lone-star-electric"));
  fs.writeFileSync(path.join(dir, "01-lone-star-electric", "app.pdf"), "%PDF-1.4");
  fs.writeFileSync(path.join(dir, "01-lone-star-electric", ".DS_Store"), "x");
  fs.mkdirSync(path.join(dir, "02-empty"));
  fs.writeFileSync(path.join(dir, "stray.txt"), "not a folder");
  return dir;
}

test("folder titles drop the case number", () => {
  assert.equal(folderTitle("09-rio-bravo-concrete"), "Rio Bravo Concrete");
  assert.equal(folderTitle("acme_roofing"), "Acme Roofing");
  assert.equal(folderTitle("06-empire-builders-gc"), "Empire Builders GC");
  assert.equal(folderTitle("14-silver-state-hvac"), "Silver State HVAC");
});

test("names that could escape the drop folder are refused", () => {
  for (const bad of ["..", "../etc", "a/b", ".hidden", "", "a\\b"]) assert.equal(isSafeName(bad), false, bad);
  assert.equal(isSafeName("09-rio-bravo-concrete"), true);
});

test("content types come from the extension", () => {
  assert.equal(contentTypeFor("x.PDF"), "application/pdf");
  assert.equal(contentTypeFor("mail.eml"), "message/rfc822");
  assert.equal(contentTypeFor("x.exe"), "application/octet-stream");
});

test("the inbox lists folders with documents and skips dotfiles, empty folders and loose files", () => {
  const inbox = readInbox(dropFolder());
  assert.deepEqual(inbox.map((f) => f.folder), ["01-lone-star-electric"]);
  assert.deepEqual(inbox[0].files.map((f) => f.name), ["app.pdf"]);
  assert.equal(inbox[0].title, "Lone Star Electric");
});

test("loading a folder returns Files and refuses traversal, missing folders and oversize folders", () => {
  const dir = dropFolder();
  const [file] = loadFolder(dir, "01-lone-star-electric", 1024);
  assert.equal(file.name, "app.pdf");
  assert.equal(file.type, "application/pdf");
  assert.throws(() => loadFolder(dir, "../etc", 1024), /Not an inbox folder/);
  assert.throws(() => loadFolder(dir, "99-gone", 1024), /no longer in the inbox/);
  assert.throws(() => loadFolder(dir, "01-lone-star-electric", 4), /larger than/);
});

test("the drop folder is the env var, else repo samples, else ./inbox", () => {
  assert.equal(inboxDir("/app", { SUBMISSION_INBOX_DIR: "/data/inbox" }), "/data/inbox");
  assert.equal(inboxDir("/nowhere/web", {}), "/nowhere/web/inbox");
  const repoWeb = path.resolve(import.meta.dirname, "..", "..");
  assert.equal(inboxDir(repoWeb, {}), path.resolve(repoWeb, "..", "samples", "submissions"));
});
