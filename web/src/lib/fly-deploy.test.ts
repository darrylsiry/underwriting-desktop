import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// scripts/fly-deploy.sh run for real, in a throwaway git repo with a stand-in `fly` first on PATH, so
// nothing here reaches Fly or touches this checkout. CR-131: when Fly can't be asked which secrets
// exist, a local deploy used to replace every login and overwrite the saved passwords.

const SCRIPT = path.resolve("../scripts/fly-deploy.sh");
const ALL_SECRETS = '[{"Name":"DATABASE_URL"},{"Name":"CUSTOMER_DATABASE_URL"},{"Name":"POLICY_DATABASE_URL"},{"Name":"RATING_ADMIN_TOKEN"},{"Name":"ANTHROPIC_API_KEY"},{"Name":"BASIC_AUTH_USERS"}]';
const NO_LOGINS = ALL_SECRETS.replace(',{"Name":"BASIC_AUTH_USERS"}', "");
const SAVED = "url=https://uwdesk-web.fly.dev\nunderwriter1=saved-password\nunderwriter2=another-saved-password\n";

const FLY_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FLY_STUB_LOG"
case "$*" in
  "secrets list "*)
    if [ -n "\${FLY_STUB_LIST_FAILS:-}" ]; then echo "Error: could not reach the API" >&2; exit 1; fi
    printf '%s\\n' "$FLY_STUB_SECRETS" ;;
  "secrets import "*) sed 's/=.*/=<value>/' >> "$FLY_STUB_LOG" ;;
  "apps list "*) echo '[{"Name":"uwdesk-web"},{"Name":"uwdesk-rating"},{"Name":"uwdesk-ingestion"}]' ;;
  "mpg list "*) echo '[{"name":"uwdesk-db","id":"cluster1"}]' ;;
  "mpg databases list "*) echo "customer policy rating" ;;
  "ips list "*) echo '[{"Type":"private_v6"}]' ;;
esac
exit 0
`;

function deploy(o: { secrets?: string; listFails?: boolean; credentials?: string; ci?: boolean }) {
  const root = mkdtempSync(path.join(tmpdir(), "fly-deploy-"));
  const log = path.join(root, ".fly-calls");
  const env = {   // nothing else from this shell: no CI, no real Fly token, no GIT_DIR
    PATH: `${path.join(root, ".bin")}:${process.env.PATH}`, HOME: root,
    FLY_STUB_LOG: log, FLY_STUB_SECRETS: o.secrets ?? ALL_SECRETS,
    ...(o.listFails ? { FLY_STUB_LIST_FAILS: "1" } : {}), ...(o.ci ? { CI: "true" } : {}),
  } as unknown as NodeJS.ProcessEnv;
  try {
    // Its own repo, or the script's "cd to the top of the repo" would find this one.
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root, env }).status, 0);
    for (const d of ["scripts", ".bin", "web/inbox", "web/agent-reports", "samples/submissions", "docs"]) mkdirSync(path.join(root, d), { recursive: true });
    copyFileSync(SCRIPT, path.join(root, "scripts/fly-deploy.sh"));
    writeFileSync(path.join(root, ".bin/fly"), FLY_STUB, { mode: 0o755 });
    writeFileSync(log, "");
    const creds = path.join(root, ".fly-credentials");
    if (o.credentials !== undefined) writeFileSync(creds, o.credentials);
    const r = spawnSync("bash", [path.join(root, "scripts/fly-deploy.sh")], { cwd: root, env, encoding: "utf8" });
    return {
      status: r.status, out: `${r.stdout}\n${r.stderr}`, calls: readFileSync(log, "utf8"),
      credentials: existsSync(creds) ? readFileSync(creds, "utf8") : null,
      credentialsMode: existsSync(creds) ? statSync(creds).mode & 0o777 : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a failed secrets list stops the deploy before anything is changed", () => {
  const r = deploy({ listFails: true, credentials: SAVED });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Could not list secrets on uwdesk-/);
  assert.ok(!r.calls.includes("secrets import"), "nothing staged");
  assert.ok(!r.calls.includes("mpg attach"), "no database re-attached");
  assert.ok(!r.calls.includes("deploy "), "nothing deployed");
  assert.equal(r.credentials, SAVED, "the saved passwords are untouched");
});

test("a failed secrets list can't create a first login either", () => {
  const r = deploy({ listFails: true });
  assert.notEqual(r.status, 0);
  assert.equal(r.credentials, null);
  assert.ok(!r.calls.includes("secrets import"));
});

test("a working list that names the logins leaves them alone and deploys", () => {
  const r = deploy({ secrets: ALL_SECRETS, credentials: SAVED });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /uwdesk-web already has user logins/);
  assert.ok(!r.calls.includes("BASIC_AUTH_USERS"), "no login staged");
  assert.ok(!r.calls.includes("mpg attach"), "attached databases stay attached");
  assert.ok(r.calls.includes("deploy web"), "and the deploy goes on");
  assert.equal(r.credentials, SAVED);
});

test("no logins on Fly but saved ones here: refuse rather than replace them", () => {
  const r = deploy({ secrets: NO_LOGINS, credentials: SAVED });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /\.fly-credentials exists.*scripts\/fly-users\.sh/);
  assert.ok(!r.calls.includes("BASIC_AUTH_USERS"), "no login staged");
  assert.ok(!r.calls.includes("deploy "), "nothing deployed");
  assert.equal(r.credentials, SAVED);
});

test("the very first deploy still creates a login and saves it privately", () => {
  const r = deploy({ secrets: NO_LOGINS });
  assert.equal(r.status, 0, r.out);
  assert.match(r.calls, /secrets import --stage -a uwdesk-web\nBASIC_AUTH_USERS=<value>/);
  assert.match(r.credentials ?? "", /^url=https:\/\/uwdesk-web\.fly\.dev\nunderwriter1=.{10,}\n$/);
  assert.equal(r.credentialsMode, 0o600);
  assert.ok(!r.out.includes(r.credentials!.split("=").at(-1)!.trim()), "the password is never printed");
});

test("on CI a missing login still stops the run", () => {
  const r = deploy({ secrets: NO_LOGINS, ci: true });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Run scripts\/fly-deploy\.sh locally once/);
  assert.equal(r.credentials, null);
});
