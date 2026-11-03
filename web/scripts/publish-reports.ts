// Send the review agents' latest reports to App Tests on the deployment (step 30), so the page is
// current without a push.
//
//   node web/scripts/publish-reports.ts
//
// scripts/agent-ledger-hook.sh runs this whenever a report changes. .fly-reports-publish (git-ignored,
// made by scripts/reports-publish-setup.sh) holds where to send them and the token. With no such
// file this does nothing, so a fresh checkout or another worktree never publishes. Sends what
// scripts/fly-deploy.sh would copy, so never the security report (CR-097). Never prints the token.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { checkPublish, LEDGER_FILE, PUBLISHABLE_REPORTS, type PublishedFile } from "../src/lib/report-publish.ts";

const root = path.resolve(import.meta.dirname, "../..");
const docs = path.join(root, "docs");
const confFile = process.env.REPORTS_PUBLISH_FILE ?? path.join(root, ".fly-reports-publish");

function fail(message: string): never {
  console.error(`App Tests publish: ${message}`);
  process.exit(1);
}

if (!existsSync(confFile)) {
  console.log("App Tests publish: off (no .fly-reports-publish)");
  process.exit(0);
}

const conf = new Map(readFileSync(confFile, "utf8").split("\n").flatMap((line) => {
  const eq = line.indexOf("=");
  return eq > 0 ? [[line.slice(0, eq).trim(), line.slice(eq + 1).trim()] as const] : [];
}));
const url = conf.get("url");
const token = conf.get("token");
if (!url || !token) fail(`${confFile} needs url= and token=`);
// The token goes only over TLS, or to this machine (the sandbox).
if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:|$))/.test(url)) fail(`won't send the token to ${url}`);

const file = (name: string): PublishedFile => {
  const full = path.join(docs, name);
  return { name, text: readFileSync(full, "utf8"), written_at: statSync(full).mtime.toISOString() };
};
const names = [LEDGER_FILE, ...PUBLISHABLE_REPORTS.map((a) => a.file)].filter((name) => existsSync(path.join(docs, name)));
const mockups = existsSync(path.join(docs, "ux-mockups"))
  ? readdirSync(path.join(docs, "ux-mockups")).filter((f) => /^UX-\d{3,4}\.html$/.test(f)).map((f) => `ux-mockups/${f}`)
  : [];

// The same rules the deployment applies: a report caught mid-write stops here, and the next change tries again.
const checked = checkPublish({ files: [...names, ...mockups].map(file) });
if ("error" in checked) fail(`nothing sent: ${checked.error}`);

// No redirects: the token goes to the address in the file and nowhere else.
const res = await fetch(`${url}/api/reports/publish`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ files: checked.files }),
  redirect: "error",
  signal: AbortSignal.timeout(90_000),   // a stopped Fly machine has to wake first
}).catch((err: Error) => fail(`couldn't reach ${url}: ${err.message}`));
const answer = await res.json().catch(() => null) as { outcome?: string; error?: { message?: string } } | null;
if (!res.ok) fail(`${url} answered ${res.status}: ${answer?.error?.message ?? "no details"}`);
console.log(`App Tests publish: ${checked.files.length} files, ${answer?.outcome} at ${url}`);
