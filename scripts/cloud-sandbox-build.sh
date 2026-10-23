#!/usr/bin/env bash
# Build the docker compose images inside a Claude Code cloud sandbox.
#
# Containers there can't reach the sandbox's HTTPS proxy or trust its CA, so
# plain `docker compose up --build` fails on pip/npm. This builds each image
# from a temporary copy of its Dockerfile that trusts the proxy CA, tags it
# the way compose expects, then starts the stack with --no-build.
# On a laptop or on Fly, just use `docker compose up --build`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CA=/root/.ccr/ca-bundle.crt
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rm -f "$ROOT"/services/*/.sandbox-ca.crt "$ROOT"/web/.sandbox-ca.crt' EXIT

pgrep dockerd >/dev/null || { nohup dockerd >/tmp/dockerd.log 2>&1 & sleep 5; }

inject() {  # $1 Dockerfile, $2 ENV line to add after every FROM
  awk -v env="$2" '{print} /^FROM /{print "COPY .sandbox-ca.crt /usr/local/share/ca-certificates/sandbox-ca.crt"; print env}' "$1"
}
PY_ENV='ENV SSL_CERT_FILE=/usr/local/share/ca-certificates/sandbox-ca.crt PIP_CERT=/usr/local/share/ca-certificates/sandbox-ca.crt UV_NATIVE_TLS=1'
NODE_ENV_LINE='ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/sandbox-ca.crt'
ARGS=(--network host --build-arg "HTTPS_PROXY=${HTTPS_PROXY:-}" --build-arg "https_proxy=${HTTPS_PROXY:-}" --build-arg "HTTP_PROXY=${HTTP_PROXY:-}")

build() {  # $1 context dir, $2 image name, $3 ENV line
  cp "$CA" "$1/.sandbox-ca.crt"
  inject "$1/Dockerfile" "$3" > "$TMP/$2.Dockerfile"
  docker build -q "${ARGS[@]}" -f "$TMP/$2.Dockerfile" -t "underwriting-desktop-$2" "$1"
}

for svc in "$ROOT"/services/*/; do build "$svc" "$(basename "$svc")" "$PY_ENV"; done
build "$ROOT/web" web "$NODE_ENV_LINE"
docker compose -f "$ROOT/docker-compose.yml" up -d --no-build
