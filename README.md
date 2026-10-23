# Underwriting Desktop

An underwriting workbench for E&S contractors' general liability: submission
ingestion, rating, quoting, binding, and policy documents, with every
action audited. See [`docs/PLAN.md`](docs/PLAN.md) for the architecture and
build plan.

| Component | Stack | Local URL |
|-----------|-------|-----------|
| `web` (UW Desktop) | Next.js, TypeScript, Tailwind | http://localhost:3000 |
| `services/rating` | Python, FastAPI | http://localhost:8001 (rate-table admin, also proxied at `localhost:3000/admin`) |
| `services/ingestion` | Python, FastAPI, Claude | http://localhost:8002 (`POST /extract`; score with `docker compose exec ingestion python -m app.score /samples`) |
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

## Deploy to Fly.io

```bash
fly auth login
scripts/fly-deploy.sh             # or FLY_PREFIX=my-uw scripts/fly-deploy.sh
```

The script creates (only what's missing) three apps and one Managed Postgres cluster, then deploys.
Creating them starts billing on your Fly.io account.

| App | Exposure | Notes |
|-----|----------|-------|
| `<prefix>-web` | public `https://<prefix>-web.fly.dev` | HTTP Basic auth, one login per user (`BASIC_AUTH_USERS`); passwords kept in `.fly-credentials` (git-ignored). Add users with `scripts/fly-users.sh underwriter2 …` |
| `<prefix>-rating` | private `http://<prefix>-rating.flycast` | no public IPs; rate admin reached through web at `/admin` |
| `<prefix>-ingestion` | private `http://<prefix>-ingestion.flycast` | `ANTHROPIC_API_KEY` secret copied from `.env` |
| `<prefix>-db` | Managed Postgres | databases `customer`, `policy`, `rating`, attached as secrets |
