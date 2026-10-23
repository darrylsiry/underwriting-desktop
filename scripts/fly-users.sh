#!/usr/bin/env bash
# Add user logins to the deployed UW Desktop (HTTP Basic auth, one password per user).
#
#   scripts/fly-users.sh underwriter2 underwriter3     # add these users
#   scripts/fly-users.sh                               # just re-sync the secret from the file
#
# Logins live in .fly-credentials (git-ignored, mode 600) as name=password lines. New names get a
# generated password; then BASIC_AUTH_USERS on the web app is set from the whole file, which
# restarts the web machines. Passwords are never printed: share them from the file.
set -euo pipefail
WEB="${FLY_PREFIX:-uwdesk}-web"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
CRED="$ROOT/.fly-credentials"
umask 077
[ -f "$CRED" ] || { echo "No .fly-credentials: run scripts/fly-deploy.sh first (it creates underwriter1)"; exit 1; }

# Older files hold a single user as user=/password= lines; turn them into name=password.
if grep -q '^password=' "$CRED"; then
  user="$(grep '^user=' "$CRED" | cut -d= -f2-)"; pass="$(grep '^password=' "$CRED" | cut -d= -f2-)"
  { grep -vE '^(user|password)=' "$CRED"; echo "${user:-underwriter1}=$pass"; } > "$CRED.new" && mv "$CRED.new" "$CRED"
fi

for name in "$@"; do
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Bad username '$name' (letters, digits, . _ - only)"; exit 1; }
done
for name in "$@"; do
  if grep -q "^$name=" "$CRED"; then echo "$name already exists"; continue; fi
  echo "$name=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)" >> "$CRED"
  echo "added $name"
done

users="$(grep -v '^url=' "$CRED" | sed 's/=/:/' | paste -sd, -)"
[ -n "$users" ] || { echo "No users in $CRED"; exit 1; }
printf 'BASIC_AUTH_USERS=%s\n' "$users" | fly secrets import -a "$WEB"
echo "$WEB now has $(grep -vc '^url=' "$CRED") user logins (see $CRED)"
