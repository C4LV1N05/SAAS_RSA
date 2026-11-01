# SAAS_RSA

A South African platform for restaurants and hospitality, modelled on 7shifts and rebuilt around South African law: the shift a manager schedules becomes the hour an employee clocks, the rand they are paid, and the line SARS receives. Alongside it, **Serve** lets guests order and ask for the bill from their phones while the restaurant keeps its existing till.

**Stack:** TypeScript · Fastify · PostgreSQL 16 with row-level security · Auth0 · Twilio (WhatsApp, SMS) · Azure Container Apps in South Africa North.

| Pillar | Module | Status |
| --- | --- | --- |
| Schedule | Scheduling (drafts, publish, rotation patterns) | API + schema |
| Schedule | Time Clocking (offline-safe, idempotent, geofenced) | API + schema |
| Schedule | Labour Compliance (BCEA rule engine) | Engine + API |
| Pay | Payroll (PAYE, UIF, SDL, ETI, coded payslip lines, EMP201 values) | Engine + preview API |
| Pay | Tip Management (pools, FOH/BOH split, kept out of the NMW test) | Engine + API |
| Retain | Manager Log Book (append-only, hash-chained, revisions) | API + schema |
| Serve | Table ordering by QR/NFC, kitchen and bar routing with live screens | API + schema |
| Serve | Stock deducted per order, sold-out items, deliveries and stock-takes | API + schema |
| Serve | Split bills (own items, the rest, equal shares), paid on the till's card machine | API + schema |
| Serve | Tips to the waiter by personal QR code or table assignment | API + schema |
| Serve | Till sync: signed webhooks for every tab, order, void and payment | API + worker |
| Serve | Guest ordering app; floor, kitchen and bar screens for staff | Web app |

## Repository layout

```
apps/
  api/        Fastify REST API (Zod validation, JWT auth, tenant-scoped transactions)
  web/        Guest ordering app (/t/<table code>) and staff screens (/staff): React + Vite
  worker/     Background worker: Twilio messages (WhatsApp -> SMS) and till webhooks, from database outboxes
packages/
  domain/     Pure TypeScript: BCEA segmentation + checks, SA payroll, tips, hash chain, rule registry
  db/         Drizzle schema, migration runner, seed, withTenant()
infra/
  azure/      Bicep: PostgreSQL, Container Apps (api, worker), migrate job
  auth0/      Post-Login Action that adds tenant claims to access tokens
db/
  migrations/ SQL source of truth: tables, RLS policies, immutability triggers
docs/
  ARCHITECTURE.md   Decisions, assumptions awaiting sign-off, next steps
  SERVE.md          Table ordering: flow, guest API, till webhook contract
  DEPLOY_AZURE.md   One-time Azure, Auth0 and Twilio setup
  BLUEPRINT.md      The original architectural blueprint
```

## Quick start

Requires Node 22, pnpm 10 and Docker.

```bash
cp .env.example .env
docker compose up -d                     # PostgreSQL 16
pnpm install
pnpm db:migrate                          # tables, RLS, and the saas_app / saas_worker roles
pnpm --filter @saas-rsa/db seed          # national rule versions + public holidays
pnpm dev:api                             # http://localhost:3000/health
DATABASE_URL=$DATABASE_WORKER_URL pnpm dev:worker   # logs messages until Twilio is set
pnpm dev:web                             # http://localhost:5173
```

**Try the screens with a demo restaurant.** This creates "Ember & Salt" with a menu, stock, six tables and a waiter's tip code. It prints each table's ordering link and 15-minute staff tokens:

```bash
DATABASE_OWNER_URL=... AUTH_DEV_SECRET=... GUEST_APP_URL=http://localhost:5173 pnpm demo
```

Open a table link in a phone-sized window to order, and `http://localhost:5173/staff` in another window (paste the waiter token) to confirm the table, watch the kitchen and bar screens, and record payments.

## Tests

```bash
pnpm typecheck
pnpm test:unit                           # domain engine: payroll, BCEA, bills, stock, tips (no database)
# With a migrated + seeded database (see .env.example):
pnpm --filter @saas-rsa/db test          # RLS: tenant, location, role and append-only rules as saas_app
pnpm --filter @saas-rsa/api test         # end-to-end: workforce flow, Serve flow, Auth0 claims
pnpm --filter @saas-rsa/worker test      # Twilio adapters, outbox delivery, till webhooks
pnpm --filter @saas-rsa/web test         # pay choices, tips, docket grouping, live stream parsing
```

The payroll tests use hand-worked examples from the SARS 2026/27 tables. Validate them against SARS and a registered tax practitioner before the first live payroll.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

1. **checks**: install, typecheck, domain, worker and web tests, build
2. **integration**: PostgreSQL 16 service; migrate twice (second run must be a no-op), seed, RLS tests, API tests
3. **images**: builds `api` and `worker` containers; on `main` it publishes them to `ghcr.io/c4lv1n05/saas_rsa-api` and `-worker`
4. **deploy** (on `main`, once Azure is set up): runs the migration job, rolls out the API and worker, checks `/health`, then builds and publishes the web app. See `docs/DEPLOY_AZURE.md`.

`main` is protected: the first two stages must pass before changes merge.

## Annual maintenance

Legal values live in `packages/domain/src/rules/sa-defaults.ts` as dated rule versions, never in code paths. Each February, before the tax year starts on 1 March, add the new PAYE table, medical credits, National Minimum Wage and any UIF/ETI changes, then run the seed. Organisation or bargaining-council overrides are rows in `rule_versions` with an `org_id`.
