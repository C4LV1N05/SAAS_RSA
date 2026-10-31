# SAAS_RSA

A South African workforce platform for restaurants and hospitality, modelled on 7shifts and rebuilt around South African law: the shift a manager schedules becomes the hour an employee clocks, the rand they are paid, and the line SARS receives.

| Pillar | Module | Status |
| --- | --- | --- |
| Schedule | Scheduling (drafts, publish, rotation patterns) | API + schema |
| Schedule | Time Clocking (offline-safe, idempotent, geofenced) | API + schema |
| Schedule | Labour Compliance (BCEA rule engine) | Engine + API |
| Pay | Payroll (PAYE, UIF, SDL, ETI, coded payslip lines, EMP201 values) | Engine + preview API |
| Pay | Tip Management (pools, FOH/BOH split, kept out of the NMW test) | Engine + API |
| Retain | Manager Log Book (append-only, hash-chained, revisions) | API + schema |

## Repository layout

```
apps/
  api/        Fastify REST API (Zod validation, JWT auth, tenant-scoped transactions)
  worker/     BullMQ notification worker (WhatsApp -> SMS fallback)
packages/
  domain/     Pure TypeScript: BCEA segmentation + checks, SA payroll, tips, hash chain, rule registry
  db/         Drizzle schema, migration runner, seed, withTenant()
db/
  migrations/ SQL source of truth: tables, RLS policies, immutability triggers
docs/
  ARCHITECTURE.md   Decisions, assumptions awaiting sign-off, next steps
  BLUEPRINT.md      The original architectural blueprint
```

## Quick start

Requires Node 22, pnpm 10 and Docker.

```bash
cp .env.example .env
docker compose up -d                     # PostgreSQL 16 + Redis 7
pnpm install
APP_DB_PASSWORD=saas_app pnpm db:migrate # creates tables, RLS and the saas_app role
pnpm --filter @saas-rsa/db seed          # national rule versions + public holidays
pnpm dev:api                             # http://localhost:3000/health
pnpm dev:worker                          # needs REDIS_URL
```

## Tests

```bash
pnpm typecheck
pnpm test:unit                           # domain engine: 50 tests, no database
# With a migrated + seeded database (see .env.example):
pnpm --filter @saas-rsa/db test          # RLS: tenant, location, role and append-only rules as saas_app
pnpm --filter @saas-rsa/api test         # end-to-end: schedule -> publish -> clock -> approve -> tips -> payroll -> log book
```

The payroll tests use hand-worked examples from the SARS 2026/27 tables. Validate them against SARS and a registered tax practitioner before the first live payroll.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

1. **checks**: install, typecheck, domain and worker tests, build
2. **integration**: PostgreSQL 16 service; migrate twice (second run must be a no-op), seed, RLS tests, API tests
3. **images**: builds `api` and `worker` containers; on `main` it publishes them to `ghcr.io/c4lv1n05/saas_rsa-api` and `-worker`

## Annual maintenance

Legal values live in `packages/domain/src/rules/sa-defaults.ts` as dated rule versions, never in code paths. Each February, before the tax year starts on 1 March, add the new PAYE table, medical credits, National Minimum Wage and any UIF/ETI changes, then run the seed. Organisation or bargaining-council overrides are rows in `rule_versions` with an `org_id`.
