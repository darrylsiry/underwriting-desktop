#!/usr/bin/env bash
# Both Python suites in throwaway containers, so they run on any host with Docker: no uv on the host,
# and the checkout's .venv directories, built inside containers, can't run outside one (CR-096).
# Reads the checkout through a read-only mount and writes nothing to it. The rating API tests use a
# throwaway rating_test database on the compose db when it is up, and are skipped when it isn't.
# Usage: scripts/python-tests.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NETWORK=underwriting-desktop_default
network_args=()
docker network inspect "$NETWORK" >/dev/null 2>&1 && network_args=(--network "$NETWORK")

status=0
for service in rating ingestion; do
  echo "--- $service"
  docker run --rm ${network_args[@]+"${network_args[@]}"} \
    -v "$ROOT/services/$service:/src:ro" -v uwdesk-uv-cache:/root/.cache/uv \
    -v "$ROOT/samples:/samples:ro" \
    -e TEST_DATABASE_ADMIN_URL=postgresql://uw:uw@db:5432/postgres -e SAMPLES_DIR=/samples \
    python:3.12-slim sh -c '
      pip install -q --root-user-action=ignore --disable-pip-version-check uv==0.11.32 \
        && mkdir /work && cd /src && tar --exclude=.venv --exclude=__pycache__ --exclude=.pytest_cache -cf - . | tar -xf - -C /work \
        && cd /work && uv run --quiet --frozen pytest -q' || status=1
done
exit $status
