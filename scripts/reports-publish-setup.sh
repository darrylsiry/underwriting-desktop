#!/usr/bin/env bash
# Turn on report publishing for App Tests (step 30). Generates one token and puts it in two places:
# the Fly web app, as REPORTS_PUBLISH_TOKEN, and .fly-reports-publish here (git-ignored, private to
# this user) beside the address to send to. Never printed. Staged on Fly, so the next deploy applies it.
#
#   scripts/reports-publish-setup.sh
#   FLY_PREFIX=acme-uw scripts/reports-publish-setup.sh
#
# Keeps an existing token. To replace it, delete .fly-reports-publish and run this again.
set -euo pipefail
cd "$(dirname "$0")/.."
WEB="${FLY_PREFIX:-uwdesk}-web"
FILE=.fly-reports-publish
if [ -e "$FILE" ]; then
  echo "$FILE already exists; keeping its token"
  exit 0
fi
token="$(openssl rand -hex 32)"
printf 'REPORTS_PUBLISH_TOKEN=%s\n' "$token" | fly secrets import --stage -a "$WEB"
umask 077
printf 'url=https://%s.fly.dev\ntoken=%s\n' "$WEB" "$token" > "$FILE"
echo "REPORTS_PUBLISH_TOKEN staged on $WEB and saved to $FILE. The next deploy applies it."
