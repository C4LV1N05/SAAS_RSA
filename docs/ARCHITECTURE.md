# Architecture

This codebase implements the blueprint in `docs/BLUEPRINT.md` with the changes from the architecture review. Each review fix maps to code below.

## Review fixes and where they live

| # | Blueprint decision | Implemented as | Where |
| --- | --- | --- | --- |
| 1 | RLS `tenant_id = auth.uid()` | Membership-based tenancy: the API sets `app.org_id`, `app.user_id`, `app.role`, `app.location_ids` per transaction; permissive tenant policy + restrictive location/role/self policies; `FORCE ROW LEVEL SECURITY`; app connects as non-owner `saas_app` | `db/migrations/0001_core.sql`, `0005_rls.sql`, `packages/db/src/tenant.ts` |
| 2 | Tenant = franchise location | Organisation (legal employer, PAYE ref) -> locations; users join organisations through `memberships` | `0001_core.sql` |
| 3 | Hardcoded R30.23, R17 712, 45 h | `rule_versions` with effective dates, org overrides; every payslip records the versions it used | `packages/domain/src/rules/*`, `packages/db/src/seed.ts` |
| 4 | UIF capped at R17 712 for every period | Ceiling pro-rated to weekly/fortnightly periods | `packages/domain/src/payroll/statutory.ts` |
| 5 | Single `hourly_rate` | Dated `pay_rates` | `0002_schedule.sql`, `apps/api/src/data.ts` |
| 6 | Fixed-column `payroll_records` | `payroll_runs` -> `payslips` -> `payslip_lines` with IRP5 source codes; finalised runs locked by trigger | `0003_pay.sql`, `payroll/payslip.ts` |
| 7 | NMW on "base calculation" | NMW tested on hourly earnings per hour worked, tips excluded | `bcea/checks.ts`, `payroll/payslip.ts` |
| 8 | Money type unspecified | Integer cents (`bigint`) everywhere; largest-remainder allocation | `money.ts` |
| - | BCEA engine with 2 rules | Daily/weekly ordinary limits (9 h/8 h, 45 h), overtime agreement and caps (3 h/day, 10 h/week), Sunday 1.5x/2x, public holiday 2x, night minutes, 12 h daily rest, 36 h weekly rest, meal interval, NMW; runs on schedules (publish gate) and actual hours | `bcea/segment.ts`, `bcea/checks.ts` |
| - | Append-only log book | Revisions as new rows + per-location SHA-256 hash chain + `/v1/logbook/verify` | `0004_retain.sql`, `logbook/hashchain.ts`, `routes/logbook.ts` |

## Decisions for the outstanding tasks

- **Task 1, auth (Auth0):** Auth0 issues short-lived RS256 access tokens; the API verifies them against the tenant JWKS, issuer and audience. A Post-Login Action calls `POST /internal/auth/claims` (shared secret) and adds namespaced claims `user_id`, `org_id`, `role`, `location_ids`. Staff sign in by SMS passwordless; the first login links the Auth0 account to the invited user by verified phone (`app.resolve_login`). RBAC runs at the edge (`permissions.ts`) and again in RLS.
- **Task 2, API:** TypeScript, Fastify, REST, Zod, Drizzle on node-postgres. Each request is one transaction with tenant context. Clock actions require an `Idempotency-Key`.
- **Task 3, notifications (Twilio):** a transactional outbox (`notification_outbox`) written in the same transaction as the change, so a rolled-back publish sends nothing. The worker connects as `saas_worker`, which can only call `app.claim_notifications` (SKIP LOCKED, leased) and `app.complete_notification` (exponential backoff, 6 attempts). Delivery: WhatsApp via approved Twilio Content templates, falling back to SMS. Redis was dropped because new Azure Cache for Redis instances are no longer available to new customers.
- **Task 4, infrastructure (Azure):** `infra/azure/main.bicep` in South Africa North: PostgreSQL 16 Flexible Server, Container Apps for the API and worker, and a manual migration job using the API image. CI deploys on every green push to `main` via OIDC. See `docs/DEPLOY_AZURE.md`.
- **Task 5, integrations:** EMP201 is captured on SARS eFiling, so the system produces its values (`emp201Totals`), not a file. EMP501/IRP5 export to the SARS BRS and Xero/Sage journals build on the coded payslip lines.

## Assumptions that need sign-off before go-live

Labour lawyer:
- The daily ordinary limit applies to the date a shift starts; minutes after midnight are priced on the new date.
- Sunday and public holiday minutes count toward the ordinary limits; overtime on those days takes the higher multiplier.
- Employees above the BCEA earnings threshold get no overtime or Sunday premium but keep public holiday double pay.
- Weeks run Monday to Sunday.

Registered tax practitioner:
- PAYE uses the annualise-the-period method; irregular income (bonuses, leave payouts) needs the year-to-date method, not yet implemented.
- Tips paid through payroll are taxed as remuneration (IRP5 3601) and excluded from the UIF base; lines are flagged `needsReview`.
- ETI amounts follow the 1 April 2025 table; weekly and fortnightly payrolls need month-end ETI aggregation.

## Not built yet

- Persisted payroll runs (draft -> approved -> finalised -> paid), payslip PDFs, EFT bank files
- EMP501 / IRP5 e@syFile export, Xero/Sage journal export
- Leave accrual and payouts (ledger table exists), terminations and UI-19
- Rotation pattern expansion into shifts
- Field-level encryption for ID, tax and bank numbers (columns exist as `bytea`)
- Real-time manager alerts (SSE or a managed realtime service)
- Twilio delivery status callbacks (the outbox records the message SID for this)
- Web and mobile clients
