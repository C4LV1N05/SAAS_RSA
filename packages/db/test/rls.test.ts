/**
 * Proves tenant isolation in the database itself, connecting as saas_app (the role
 * the API uses). Requires a migrated + seeded database:
 *   DATABASE_OWNER_URL=... DATABASE_URL=... pnpm --filter @saas-rsa/db test
 * Skipped when those variables are not set.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.DATABASE_OWNER_URL;
const APP_URL = process.env.DATABASE_URL;

type Ctx = { orgId: string; userId: string; role: string; locationIds?: string[] };

async function inContext<T>(pool: pg.Pool, ctx: Ctx | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (ctx) {
      await client.query(
        `select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.role', $3, true), set_config('app.location_ids', $4, true)`,
        [ctx.orgId, ctx.userId, ctx.role, (ctx.locationIds ?? []).join(',')],
      );
    }
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

describe.skipIf(!OWNER_URL || !APP_URL)('row-level security (as saas_app)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;

  const id = () => randomUUID();
  const A = { org: id(), loc1: id(), loc2: id(), owner: id(), manager: id(), staffUser: id(), payroll: id() };
  const B = { org: id(), loc: id(), owner: id() };
  const emp = { a1: id(), a2: id(), b1: id() };
  const shift = { a1: id(), a2: id() };
  const entry = { a1: id(), a2: id() };
  const run = id();
  const slip = id();

  const ctxA = (role: string, userId: string, locationIds: string[] = []): Ctx => ({ orgId: A.org, userId, role, locationIds });

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    app = new pg.Pool({ connectionString: APP_URL });

    // Fixtures are written as the owner role, which FORCE RLS also binds,
    // so each organisation's rows are created inside its own context.
    for (const [org, ownerUser, name] of [[A.org, A.owner, 'Org A'], [B.org, B.owner, 'Org B']] as const) {
      await inContext(owner, { orgId: org, userId: ownerUser, role: 'owner' }, async (c) => {
        await c.query('insert into organisations (id, legal_name) values ($1, $2)', [org, name]);
      });
    }
    await inContext(owner, ctxA('owner', A.owner), async (c) => {
      for (const u of [A.owner, A.manager, A.staffUser, A.payroll]) {
        await c.query('insert into users (id, display_name) values ($1, $2)', [u, `user ${u.slice(0, 4)}`]);
      }
      await c.query('insert into locations (id, org_id, name) values ($1, $3, $4), ($2, $3, $5)', [A.loc1, A.loc2, A.org, 'Rosebank', 'Sandton']);
      await c.query(
        `insert into memberships (org_id, user_id, role, location_ids) values
           ($1, $2, 'owner', '{}'), ($1, $3, 'shift_manager', array[$5::uuid]),
           ($1, $4, 'employee', array[$5::uuid]), ($1, $6, 'payroll_admin', '{}')`,
        [A.org, A.owner, A.manager, A.staffUser, A.loc1, A.payroll],
      );
      await c.query(
        `insert into employees (id, org_id, user_id, home_location_id, first_name, last_name, employment_start) values
           ($1, $3, $4, $5, 'Thandi', 'Mokoena', '2026-01-01'),
           ($2, $3, null, $6, 'Pieter', 'Botha', '2026-01-01')`,
        [emp.a1, emp.a2, A.org, A.staffUser, A.loc1, A.loc2],
      );
      await c.query(
        `insert into shifts (id, org_id, location_id, employee_id, starts_at, ends_at, status) values
           ($1, $3, $4, $6, '2026-11-02 08:00+02', '2026-11-02 16:00+02', 'published'),
           ($2, $3, $5, $7, '2026-11-02 08:00+02', '2026-11-02 16:00+02', 'published')`,
        [shift.a1, shift.a2, A.org, A.loc1, A.loc2, emp.a1, emp.a2],
      );
      await c.query(
        `insert into time_entries (id, org_id, location_id, employee_id, clock_in, clock_out, method, idempotency_key) values
           ($1, $3, $4, $6, '2026-11-02 08:00+02', '2026-11-02 16:00+02', 'mobile', $8),
           ($2, $3, $5, $7, '2026-11-02 08:00+02', '2026-11-02 16:00+02', 'kiosk', $9)`,
        [entry.a1, entry.a2, A.org, A.loc1, A.loc2, emp.a1, emp.a2, `key-${entry.a1}`, `key-${entry.a2}`],
      );
      const period = id();
      await c.query(`insert into pay_periods (id, org_id, frequency, starts_on, ends_on, pay_date) values ($1, $2, 'weekly', $3, $4, $5)`, [
        period, A.org, '2020-01-06', '2020-01-12', '2020-01-17',
      ]);
      await c.query(`insert into payroll_runs (id, org_id, pay_period_id) values ($1, $2, $3)`, [run, A.org, period]);
      await c.query(
        `insert into payslips (id, org_id, payroll_run_id, employee_id, gross_cents, deductions_cents, net_cents, employer_cost_cents)
         values ($1, $2, $3, $4, 100000, 1000, 99000, 101000)`,
        [slip, A.org, run, emp.a1],
      );
      await c.query(`update payroll_runs set status = 'finalised', finalised_at = now() where id = $1`, [run]);
    });
    await inContext(owner, { orgId: B.org, userId: B.owner, role: 'owner' }, async (c) => {
      await c.query('insert into users (id, display_name) values ($1, $2)', [B.owner, 'Owner B']);
      await c.query('insert into locations (id, org_id, name) values ($1, $2, $3)', [B.loc, B.org, 'Durban']);
      await c.query(
        `insert into employees (id, org_id, home_location_id, first_name, last_name, employment_start) values ($1, $2, $3, 'Sipho', 'Dlamini', '2026-01-01')`,
        [emp.b1, B.org, B.loc],
      );
    });
  });

  afterAll(async () => {
    await owner?.end();
    await app?.end();
  });

  const employeeIds = (c: pg.PoolClient) => c.query<{ id: string }>('select id from employees').then((r) => r.rows.map((x) => x.id));

  it('returns nothing when no tenant context is set', async () => {
    await inContext(app, null, async (c) => {
      expect((await c.query('select * from employees')).rowCount).toBe(0);
      expect((await c.query('select * from organisations')).rowCount).toBe(0);
    });
  });

  it("never shows another organisation's rows", async () => {
    const ids = await inContext(app, ctxA('owner', A.owner), employeeIds);
    expect(ids).toEqual(expect.arrayContaining([emp.a1, emp.a2]));
    expect(ids).not.toContain(emp.b1);
  });

  it('rejects writes into another organisation', async () => {
    await expect(
      inContext(app, ctxA('owner', A.owner), (c) =>
        c.query(`insert into employees (org_id, home_location_id, first_name, last_name, employment_start) values ($1, $2, 'X', 'Y', '2026-01-01')`, [B.org, B.loc]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('limits a shift manager to their own locations', async () => {
    await inContext(app, ctxA('shift_manager', A.manager, [A.loc1]), async (c) => {
      const shifts = (await c.query<{ id: string }>('select id from shifts')).rows.map((r) => r.id);
      expect(shifts).toEqual([shift.a1]);
      expect(await employeeIds(c)).toEqual([emp.a1]);
    });
  });

  it('shows an employee only their own records and payslips', async () => {
    await inContext(app, ctxA('employee', A.staffUser, [A.loc1]), async (c) => {
      expect((await c.query<{ id: string }>('select id from time_entries')).rows.map((r) => r.id)).toEqual([entry.a1]);
      expect((await c.query('select id from payroll_runs')).rowCount).toBe(0);
      expect((await c.query<{ id: string }>('select id from payslips')).rows.map((r) => r.id)).toEqual([slip]);
      expect((await c.query('select id from compliance_findings')).rowCount).toBe(0);
    });
  });

  it('keeps finalised payslips immutable', async () => {
    await expect(
      inContext(app, ctxA('payroll_admin', A.payroll), (c) => c.query('update payslips set net_cents = 1 where id = $1', [slip])),
    ).rejects.toThrow(/immutable|finalised/);
  });

  it('keeps the log book away from payroll admins and append-only for managers', async () => {
    const logId = id();
    await inContext(app, ctxA('shift_manager', A.manager, [A.loc1]), (c) =>
      c.query(
        `insert into manager_logs (id, org_id, location_id, entry_group_id, revision, author_user_id, category, body, seq, prev_hash, hash)
         values ($1, $2, $3, $1, 1, $4, 'handover', 'Walk-in fridge at 7C, technician booked', 1, $5, $6)`,
        [logId, A.org, A.loc1, A.manager, '0'.repeat(64), 'f'.repeat(64)],
      ),
    );
    expect(await inContext(app, ctxA('payroll_admin', A.payroll), (c) => c.query('select id from manager_logs').then((r) => r.rowCount))).toBe(0);
    await expect(
      inContext(app, ctxA('owner', A.owner), (c) => c.query(`update manager_logs set body = 'edited' where id = $1`, [logId])),
    ).rejects.toThrow(/permission denied|append-only/);
  });

  it('lets everyone read national rules but nobody but the owner write them', async () => {
    await inContext(app, ctxA('employee', A.staffUser, [A.loc1]), async (c) => {
      const r = await c.query(`select value from rule_versions where key = 'nmw.hourly_cents' and effective_from = '2026-03-01'`);
      expect(r.rows[0]?.value).toBe(3023);
    });
    await expect(
      inContext(app, ctxA('owner', A.owner), (c) =>
        c.query(`insert into rule_versions (org_id, key, value, effective_from, source) values (null, 'nmw.hourly_cents', '1', '2030-01-01', 'x')`),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('refuses to delete audit history', async () => {
    await expect(inContext(app, ctxA('owner', A.owner), (c) => c.query('delete from audit_log'))).rejects.toThrow(/permission denied/);
  });
});
