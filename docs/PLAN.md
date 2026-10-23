# Build plan

## Line of business: Excess & Surplus contractors' General Liability

- **One coverage line:** no property or COPE data and no multi-line package
  logic. This keeps rating, forms, and documents simple.
- **Real specialty business:** E&S contractors' GL is a core specialty line
  that needs real underwriter judgment (subcontracting, residential work,
  loss history, wrap-ups).
- **Uses standard forms:** GL submissions come on ACORD 125 (commercial
  application) and ACORD 126 (GL section), so we can still show ACORD
  ingestion. We also add non-ACORD formats (broker email, supplemental
  questionnaire, loss runs), as real specialty submissions arrive in many
  shapes.
- **Fake submissions:** ACORD forms are copyrighted, so we generate
  **ACORD-style look-alikes** rather than copies.

## Architecture

```
                 ┌──────────────────────────┐
  Underwriter ──▶│  web  (UW Desktop)       │── customer DB (insureds, submissions, docs)
                 │  Next.js + TypeScript    │── policy DB   (quotes, binders, policies)
                 │  PDFs: quote/binder/policy│── audit_events (append-only)
                 └──────┬──────────┬────────┘
              HTTP/JSON │          │ HTTP/JSON
     ┌──────────────────▼──┐   ┌───▼──────────────────────┐
     │ ingestion-service   │   │ rating-service           │── rating DB (rate tables,
     │ Python / FastAPI    │   │ Python / FastAPI         │   versions, rating log)
     │ PDF form fields +   │   │ POST /rate               │
     │ Claude extraction   │   │ /admin  rate-table UI    │
     └─────────────────────┘   └──────────────────────────┘
```

- **Databases:** Postgres. There are three logical databases (`customer`,
  `policy`, `rating`), each owned by exactly one service. On Fly they share
  one Postgres cluster to keep cost and ops low. Locally they run in one
  container from docker compose.
- **Extraction:**
  - Structured ACORD-style PDFs are read **deterministically** from their
    form fields.
  - Unstructured documents (emails, questionnaires, loss runs) go to
    **Claude**, which returns structured JSON with a confidence value and a
    source snippet for each field.
  - This needs `ANTHROPIC_API_KEY`. Without it, the service falls back to
    the deterministic path only.
- **Rating:**
  - Formula: `base rate (class) × exposure (revenue or payroll) / 1000 ×
    territory factor × ILF (limit) × deductible factor × schedule mod`,
    with a minimum premium.
  - Rate tables are versioned. Every quote records the rate version it used.
- **Audit:**
  - Every mutating API call writes an `audit_events` row (who, what, entity,
    before/after, correlation ID).
  - The rating service keeps its own log of rate calls and rate-table edits.
  - The desktop shows a unified audit timeline.
- **Deployment:** four Fly apps (`web`, `ingestion`, `rating`, plus a Fly
  Postgres cluster). Services talk over Fly private networking
  (`*.internal`).

## Steps (each one is a demo-sized unit, committed as `step-NN:`)

| #  | Step | Shows off |
|----|------|-----------|
| 01 | Monorepo skeleton, docker compose, Postgres with 3 DBs, health checks | Multi-service scaffolding in one prompt |
| 02 | Fake submission generator: about 8 submissions mixing ACORD-style 125/126 PDFs, broker emails, questionnaires, loss runs | Realistic test data |
| 03 | Rating service: rate tables, `POST /rate`, unit tests | Domain logic plus tests |
| 04 | Rating admin UI: edit factors per variable, versioned, audited | A second UI on a separate service |
| 05 | Ingestion service: upload → classify → extract → submission JSON with confidence | Claude inside the product |
| 06 | UW Desktop: submission inbox, intake review (accept or fix extracted fields) | Full-stack feature |
| 07 | Underwriting workbench: edit rating inputs, schedule credits/debits with written rationale, referral flags | Domain UX |
| 08 | Rate via API → persisted quote → quote PDF | Service-to-service integration |
| 09 | Bind → binder PDF plus policy document PDF | Document generation |
| 10 | Search and inspect customers, submissions, quotes, policies | Data access |
| 11 | Unified audit trail viewer | Cross-cutting concern |
| 12 | Fly.io deploy: `fly.toml` per service, secrets, private networking | Ops |

## Live demo suggestion

Replaying all 12 steps live is too much for one session. Suggested flow:
start the live repo blank, replay steps 01, 03, and 05 live (scaffold,
rating engine, Claude extraction). Then switch to the finished reference app
for the end-to-end walkthrough (ingest → rate → quote → bind → audit).
