#!/usr/bin/env bash
# Deploy Underwriting Desktop to Fly.io: three apps and one Managed Postgres cluster.
#
#   scripts/fly-deploy.sh            # create what's missing, then deploy all three apps
#   FLY_PREFIX=acme-uw scripts/fly-deploy.sh
#
# Also runs from GitHub Actions on every push to main (.github/workflows/fly-deploy.yml).
#
# Safe to re-run: apps, the cluster, databases, attachments and secrets are only created when
# missing. Creating the cluster and apps starts billing on your Fly.io account.
#
#   <prefix>-web        public, https://<prefix>-web.fly.dev, behind HTTP Basic auth
#   <prefix>-rating     private, http://<prefix>-rating.flycast (no public IPs)
#   <prefix>-ingestion  private, http://<prefix>-ingestion.flycast
#   <prefix>-db         Managed Postgres with databases customer, policy, rating
#
# Secrets: ANTHROPIC_API_KEY comes from .env if set there. The first user login (underwriter1) is
# generated on first run and saved to .fly-credentials (git-ignored, mode 600), never printed.
# More users: scripts/fly-users.sh.
set -euo pipefail

PREFIX="${FLY_PREFIX:-uwdesk}"
REGION="${FLY_REGION:-iad}"
ORG="${FLY_ORG:-personal}"
PLAN="${FLY_PG_PLAN:-Basic}"
WEB="$PREFIX-web" RATING="$PREFIX-rating" INGESTION="$PREFIX-ingestion" DB="$PREFIX-db"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"

step() { printf '\n==> %s\n' "$*"; }
has_secret() { fly secrets list -a "$1" --json 2>/dev/null | grep -q "\"$2\""; }
cluster_id() {
  fly mpg list --org "$ORG" --json 2>/dev/null | python3 -c '
import json, sys
try:
    clusters = json.load(sys.stdin)
except ValueError:
    clusters = []
for c in clusters if isinstance(clusters, list) else []:
    if c.get("name", c.get("Name")) == sys.argv[1]:
        print(c.get("id", c.get("ID", "")))
' "$DB"
}

fly auth whoami >/dev/null || { echo "Run 'fly auth login' first"; exit 1; }

step "Apps ($PREFIX-*) in org $ORG"
existing="$(fly apps list --org "$ORG" --json)"
for app in "$RATING" "$INGESTION" "$WEB"; do
  if grep -q "\"$app\"" <<<"$existing"; then echo "$app exists"; else fly apps create --name "$app" --org "$ORG"; fi
done

step "Managed Postgres cluster $DB ($PLAN, $REGION)"
id="$(cluster_id)"
if [ -z "$id" ]; then
  # flyctl prints the connection string (with password) here and on attach; keep it off the terminal.
  fly mpg create --name "$DB" --org "$ORG" --region "$REGION" --plan "$PLAN" >/dev/null
  id="$(cluster_id)"
fi
[ -n "$id" ] || { echo "Could not find cluster $DB after creating it"; exit 1; }
echo "cluster $id"
dbs="$(fly mpg databases list "$id" 2>/dev/null || true)"
for name in customer policy rating; do
  if grep -qw "$name" <<<"$dbs"; then echo "database $name exists"; else fly mpg databases create "$id" --name "$name"; fi
done

step "Database URLs (fly mpg attach sets them as secrets)"
attach() {  # app database variable
  if has_secret "$1" "$3"; then echo "$1 already has $3"
  else fly mpg attach "$id" --app "$1" --database "$2" --variable-name "$3" >/dev/null && echo "$1: $3 set"; fi
}
attach "$RATING" rating DATABASE_URL
attach "$WEB" customer CUSTOMER_DATABASE_URL
attach "$WEB" policy POLICY_DATABASE_URL

step "Secrets"
env_value() {  # name: NAME's value in .env the way docker compose reads it: quotes, an inline comment and whitespace stripped
  local raw
  raw="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true)"
  raw="${raw#"${raw%%[![:space:]]*}"}"                               # leading whitespace
  case "$raw" in
    \"*) raw="${raw#\"}"; raw="${raw%%\"*}" ;;                        # "value"  (anything after the closing quote is dropped)
    \'*) raw="${raw#\'}"; raw="${raw%%\'*}" ;;                        # 'value'
    *) raw="${raw%%[[:space:]]#*}"; raw="${raw%"${raw##*[![:space:]]}"}" ;;   # value # comment, trailing whitespace
  esac
  printf '%s' "$raw"
}
key="$(env_value ANTHROPIC_API_KEY)"
case "$key" in
  ""|sk-ant-*) ;;
  *) echo "ANTHROPIC_API_KEY in .env doesn't look like an Anthropic key (sk-ant-…); not setting it"; key="" ;;
esac
if has_secret "$INGESTION" ANTHROPIC_API_KEY; then echo "$INGESTION already has ANTHROPIC_API_KEY"
elif [ -n "$key" ]; then printf 'ANTHROPIC_API_KEY=%s\n' "$key" | fly secrets import --stage -a "$INGESTION"
else echo "No ANTHROPIC_API_KEY in .env: ingestion will read fillable PDFs only"; fi
if has_secret "$WEB" BASIC_AUTH_USERS || has_secret "$WEB" BASIC_AUTH_PASSWORD; then
  echo "$WEB already has user logins (see .fly-credentials; add users with scripts/fly-users.sh)"
elif [ -n "${CI:-}" ]; then
  # A password generated on a CI runner would be lost with the runner; create it from your machine.
  echo "$WEB has no user logins. Run scripts/fly-deploy.sh locally once to create them."; exit 1
else
  user="${BASIC_AUTH_USER:-underwriter1}"
  pass="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  printf 'BASIC_AUTH_USERS=%s:%s\n' "$user" "$pass" | fly secrets import --stage -a "$WEB"
  umask 077
  printf 'url=https://%s.fly.dev\n%s=%s\n' "$WEB" "$user" "$pass" > .fly-credentials
  echo "Login for $user saved to .fly-credentials"
fi

# Default fly.toml names are uwdesk-*; with another prefix, point the apps at each other.
overrides=()
if [ "$PREFIX" != "uwdesk" ]; then
  overrides=(-e "RATING_SERVICE_URL=http://$RATING.flycast" -e "INGESTION_SERVICE_URL=http://$INGESTION.flycast")
fi

step "Deploy private services (no public IPs) and give them Flycast addresses"
for pair in "$RATING:services/rating" "$INGESTION:services/ingestion"; do
  app="${pair%%:*}" dir="${pair#*:}"
  # --config is resolved relative to the build directory, so pass it absolute.
  fly deploy "$dir" --config "$ROOT/$dir/fly.toml" --app "$app" --no-public-ips --ha=false ${overrides[@]+"${overrides[@]}"}
  if fly ips list -a "$app" --json | grep -q '"private'; then echo "$app has a private address"
  else fly ips allocate-v6 --private -a "$app"; fi
done

step "Deploy web (public)"
# The Submissions inbox reads a drop folder; on Fly it's baked into the web image from samples/.
find "$ROOT/web/inbox" -mindepth 1 ! -name .gitkeep -exec rm -rf {} +
cp -R "$ROOT/samples/submissions/." "$ROOT/web/inbox/"
fly deploy web --config "$ROOT/web/fly.toml" --app "$WEB" --ha=false ${overrides[@]+"${overrides[@]}"}

step "Done"
echo "UW Desktop: https://$WEB.fly.dev  (credentials in .fly-credentials)"
echo "Status:     https://$WEB.fly.dev/api/health"
