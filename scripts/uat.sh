#!/usr/bin/env bash
# User-acceptance test run: tries every function of the Underwriting Desktop as a user would.
#
#   scripts/uat.sh            # sandbox + canary + prod (prod only if a UAT login is configured)
#   scripts/uat.sh sandbox    # full end-to-end flows, writes included, on a disposable local copy
#   scripts/uat.sh canary     # the read-only suite against the sandbox, proving it writes nothing
#   scripts/uat.sh prod       # the read-only suite against the live site
#   UAT_KEEP=1 scripts/uat.sh sandbox   # leave the sandbox running afterwards (http://127.0.0.1:3900, uat / uat-sandbox-pass)
#
# Nothing here writes to production:
#  - Writing flows (upload, extract, accept, rate, quote, bind, GL push, renewal, rate-table edits)
#    run only in the sandbox: its own Docker project (uwdesk-uat), database volume, inbox copy and
#    port, built from this checkout and wiped with `down -v` at the end. playwright.config.ts
#    refuses to run that suite against any non-localhost address.
#  - The live site gets the read-only suite only. Its write guard aborts every non-GET request
#    except MCP reads and the AI assistant; this script refuses to start it if a read-only spec
#    calls a write method directly; and the canary pass proves on the sandbox, table by table,
#    that the same suite leaves the databases untouched.
#  - The production login: UAT_PROD_USER / UAT_PROD_PASS, or a `uat=` line in .fly-credentials.
#    Without one the prod pass is skipped. The client logins (underwriter1-9) are never used
#    unless UAT_PROD_USER names one on purpose. The only production row a run adds is one
#    login_events "api" row per hour for that login (the API notes HTTP Basic sign-ins).
#
# Results: uat/.work/results-<pass>.json (Playwright), uat/.work/blocked-<pass>.jsonl (writes the
# guard stopped), uat/.work/canary.diff, uat/.work/summary.md. Exit code 0 only if every pass ran green.
set -uo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
WHAT="${1:-all}"
PORT="${UAT_PORT:-3900}"
SANDBOX="http://127.0.0.1:$PORT"
PROD_URL="${UAT_PROD_URL:-$(grep '^url=' .fly-credentials 2>/dev/null | cut -d= -f2-)}"
PROD_URL="${PROD_URL:-https://uwdesk-web.fly.dev}"
DC=(docker compose -p uwdesk-uat -f docker-compose.yml -f uat/docker-compose.uat.yml)
WORK=uat/.work
mkdir -p "$WORK"
: > "$WORK/summary.md"
status=0
note() { echo "$*" | tee -a "$WORK/summary.md"; }

ensure_deps() {
  [ -d uat/node_modules/@playwright/test ] || (cd uat && npm install --no-audit --no-fund >/dev/null) || { echo "npm install failed in uat/"; exit 2; }
  (cd uat && npx playwright install chromium >/dev/null 2>&1) || true
}

sandbox_up() {
  if curl -sf -u uat:uat-sandbox-pass "$SANDBOX/api/live" >/dev/null 2>&1 && [ "${UAT_FRESH:-0}" != 1 ]; then
    note "- Sandbox: reusing the one already running on $SANDBOX"
    return 0
  fi
  "${DC[@]}" down -v >/dev/null 2>&1 || true
  rm -rf "$WORK/inbox" && mkdir -p "$WORK/inbox"
  for d in $(git ls-files samples/submissions | cut -d/ -f3 | sort -u); do cp -R "samples/submissions/$d" "$WORK/inbox/"; done
  note "- Sandbox: building from $(git rev-parse --short HEAD)$(git diff --quiet HEAD -- web services || echo ' plus uncommitted changes') on $SANDBOX"
  "${DC[@]}" up -d --build > "$WORK/compose-up.log" 2>&1 || { note "  FAILED to start (see $WORK/compose-up.log)"; return 1; }
  for _ in $(seq 1 90); do
    if curl -sf -u uat:uat-sandbox-pass "$SANDBOX/api/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  curl -sf -u uat:uat-sandbox-pass "$SANDBOX/api/health" >/dev/null || { note "  sandbox never became healthy"; return 1; }
  # Wait for the seeded history (SEED_HISTORY) so list pages have records to open.
  for _ in $(seq 1 60); do
    n=$("${DC[@]}" exec -T db psql -U uw -d policy -tAc "select count(*) from policies" 2>/dev/null || echo 0)
    [ "${n:-0}" -ge "${UAT_SEED_HISTORY:-20}" ] && break
    sleep 2
  done
}

sandbox_down() {
  if [ "${UAT_KEEP:-0}" = 1 ]; then note "- Sandbox left running on $SANDBOX (uat / uat-sandbox-pass); stop it with: docker compose -p uwdesk-uat down -v"; return; fi
  "${DC[@]}" down -v >/dev/null 2>&1 && note "- Sandbox removed (containers and database volume)"
}

run_suite() {   # name mode base user pass [extra playwright args]
  local name=$1 mode=$2 base=$3 user=$4 pass=$5; shift 5
  rm -f "$WORK/blocked-$name.jsonl"; rm -rf "$WORK/artifacts-$name"
  (cd uat && UAT_PASS_NAME=$name UAT_MODE=$mode UAT_BASE_URL=$base UAT_USER=$user UAT_PASS=$pass npx playwright test "$@") > "$WORK/run-$name.log" 2>&1
  local rc=$?
  local line; line=$(grep -E '^\s+[0-9]+ (passed|failed|skipped|flaky)' "$WORK/run-$name.log" | tr -s ' ' | paste -sd, -)
  note "- $name: ${line:-no result line} (exit $rc; log $WORK/run-$name.log)"
  [ -s "$WORK/blocked-$name.jsonl" ] && note "  writes stopped by the guard: $(wc -l < "$WORK/blocked-$name.jsonl" | tr -d ' ') (see $WORK/blocked-$name.jsonl)"
  return $rc
}

static_check() {
  # Layer 3 of the write guard: read-only specs may not call write methods themselves.
  if grep -nE '\.(post|put|patch|delete)\(|\bfetch\(|page\.request|context\.request|setInputFiles' uat/tests/readonly/*.ts; then
    note "- REFUSED: a read-only spec calls a write method directly (above). Fix it before running against production."
    exit 3
  fi
}

ensure_deps
static_check

if [[ "$WHAT" == all || "$WHAT" == sandbox || "$WHAT" == canary ]]; then
  sandbox_up || { status=1; sandbox_down; exit 1; }
  if [[ "$WHAT" == all || "$WHAT" == sandbox ]]; then
    run_suite sandbox sandbox "$SANDBOX" uat uat-sandbox-pass || status=1
  fi
  if [[ "$WHAT" == all || "$WHAT" == canary ]]; then
    uat/db-fingerprint.sh > "$WORK/fingerprint-before.txt"
    run_suite canary readonly "$SANDBOX" uat uat-sandbox-pass || status=1
    uat/db-fingerprint.sh > "$WORK/fingerprint-after.txt"
    diff "$WORK/fingerprint-before.txt" "$WORK/fingerprint-after.txt" > "$WORK/canary.diff"
    unexpected=$(grep -E '^[<>]' "$WORK/canary.diff" | grep -vE ' policy\.login_events | inbox\.folders ' || true)
    if [ -n "$unexpected" ]; then
      status=1; note "- CANARY FAILED: the read-only suite changed sandbox data:"; echo "$unexpected" | sed 's/^/    /' | tee -a "$WORK/summary.md"
    else
      note "- Canary: no table changed during the read-only pass$(grep -q login_events "$WORK/canary.diff" && echo ' (login_events gained the expected API sign-in rows)')$(grep -q inbox.folders "$WORK/canary.diff" && echo '; the inbox was topped up by viewing Submissions')"
    fi
  fi
  sandbox_down
fi

if [[ "$WHAT" == all || "$WHAT" == prod ]]; then
  user="${UAT_PROD_USER:-}"; pass="${UAT_PROD_PASS:-}"
  if [ -z "$user" ] && grep -q '^uat=' .fly-credentials 2>/dev/null; then user=uat; fi
  if [ -n "$user" ] && [ -z "$pass" ]; then pass="$(grep "^$user=" .fly-credentials 2>/dev/null | head -1 | cut -d= -f2-)"; fi
  if [ -z "$user" ] || [ -z "$pass" ]; then
    note "- prod: no UAT login, so only the signed-out checks run. Add one with: scripts/fly-users.sh uat (restarts the web machines), or set UAT_PROD_USER/UAT_PROD_PASS."
    run_suite prod readonly "$PROD_URL" uat-signed-out none --grep @public || status=1
  else
    run_suite prod readonly "$PROD_URL" "$user" "$pass" || status=1
  fi
fi

note "- Overall: $([ $status = 0 ] && echo PASS || echo FAIL)"
exit $status
