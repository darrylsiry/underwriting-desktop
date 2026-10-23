# Underwriting Desktop

An underwriting workbench for E&S contractors' general liability: submission
ingestion, rating, quoting, binding, and policy documents, with every
action audited. See [`docs/PLAN.md`](docs/PLAN.md) for the architecture and
build plan.

| Component | Stack | Local URL |
|-----------|-------|-----------|
| `web` (UW Desktop) | Next.js, TypeScript, Tailwind | http://localhost:3000 |
| `services/rating` | Python, FastAPI | http://localhost:8001 (rate-table admin at `/admin`, API at `/docs`) |
| `services/ingestion` | Python, FastAPI, Claude | http://localhost:8002 (upload page at `/`, API at `/docs`) |
| `db` | Postgres 16 (`customer`, `policy`, `rating` databases) | localhost:5432 |

## Run it

```bash
cp .env.example .env        # optionally set ANTHROPIC_API_KEY
docker compose up --build
```

`http://localhost:3000` shows system status for every component;
`/api/health` returns the same as JSON.

Inside a Claude Code cloud sandbox, use `./scripts/cloud-sandbox-build.sh`
instead (see the script for why).
