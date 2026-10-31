#!/usr/bin/env bash
# The daily sign-in report: who signed in over the last 24 hours and all time, with the address,
# location, browser and language each sign-in arrived with. Asks the running app for it
# (GET /api/reports/logins), prints it, and files a copy under reports/logins/ (git-ignored).
#
#   scripts/login-report.sh                # the Fly deployment, signed in from .fly-credentials
#   scripts/login-report.sh --csv          # every recorded attempt as CSV instead of the Markdown report
#   scripts/login-report.sh --json         # the report as data
#   scripts/login-report.sh --hours 48     # a wider recent window
#   UW_URL=http://localhost:3101 UW_LOGIN=underwriter1:pw scripts/login-report.sh
#
# Run it daily by hand, from cron ("30 7 * * * /path/to/scripts/login-report.sh >/dev/null"), or
# from a scheduled Claude task. Nothing is pushed anywhere: the report stays on this machine.
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
CRED="$ROOT/.fly-credentials"
format=md hours=24
while [ $# -gt 0 ]; do
  case "$1" in
    --csv) format=csv ;;
    --json) format=json ;;
    --md|--markdown) format=md ;;
    --hours) hours="$2"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option $1 (see --help)"; exit 2 ;;
  esac
  shift
done

# Where, and as whom. UW_URL/UW_LOGIN win; otherwise the Fly site and the first login in .fly-credentials.
url="${UW_URL:-}"
login="${UW_LOGIN:-}"
if [ -z "$url" ] || [ -z "$login" ]; then
  if [ -f "$CRED" ]; then
    [ -n "$url" ] || url="$(grep '^url=' "$CRED" | head -1 | cut -d= -f2-)"
    if [ -z "$login" ]; then
      if grep -q '^password=' "$CRED"; then   # older single-user file: user=/password= lines
        login="$(grep '^user=' "$CRED" | cut -d= -f2-):$(grep '^password=' "$CRED" | cut -d= -f2-)"
        login="${login#:}"; [[ "$login" == *:* ]] || login="underwriter1:$login"
      else                                      # name=password lines
        login="$(grep -vE '^(url)=' "$CRED" | grep '=' | head -1 | sed 's/=/:/')"
      fi
    fi
  fi
fi
[ -n "$url" ] || url="https://${FLY_PREFIX:-uwdesk}-web.fly.dev"
url="${url%/}"
[ -n "$login" ] || { echo "No login: set UW_LOGIN=user:password (or run scripts/fly-deploy.sh, which writes .fly-credentials)"; exit 1; }

day="$(date -u +%F)"
out_dir="$ROOT/reports/logins"
mkdir -p "$out_dir"
out="$out_dir/$day.$format"
[ "$format" = md ] && out="$out_dir/$day.md"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

# The login goes in a header via --config so it never shows in `ps`.
status="$(curl -sS --max-time 60 -o "$tmp" -w '%{http_code}' --config <(printf 'header = "Authorization: Basic %s"\n' "$(printf '%s' "$login" | base64 | tr -d '\n')") \
  "$url/api/reports/logins?format=$format&hours=$hours")" || { echo "Could not reach $url"; exit 1; }
if [ "$status" != 200 ]; then
  echo "$url answered HTTP $status:"; head -c 400 "$tmp"; echo; exit 1
fi
cp "$tmp" "$out"
cat "$out"
echo >&2
echo "Saved to ${out#$ROOT/}" >&2
