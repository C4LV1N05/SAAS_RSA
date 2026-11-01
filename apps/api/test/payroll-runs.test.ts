/**
 * Leave and saved payroll runs end to end, against a real database.
 * Skipped when DATABASE_OWNER_URL / DATABASE_URL are not set.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Role } from '@saas-rsa/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createVerifier, signDevToken } from '../src/auth';
import { createFieldCipher } from '../src/crypto';
import { loadEnv } from '../src/env';

const OWNER_URL = process.env.DATABASE_OWNER_URL;
const APP_URL = process.env.DATABASE_URL;
const SECRET = 'test-secret-that-is-at-least-32-characters-long';

describe.skipIf(!OWNER_URL || !APP_URL)('leave and payroll runs', () => {
  const ids = {
    org: randomUUID(), loc: randomUUID(), owner: randomUUID(), manager: randomUUID(), payroll: randomUUID(),
    staffUser: randomUUID(), employee: randomUUID(), pool: randomUUID(), managerEmployee: randomUUID(),
  };
  let app: FastifyInstance;
  let ownerPool: pg.Pool;
  let closeDb: () => Promise<void>;
  const t = {} as Record<'manager' | 'staff' | 'payroll', string>;
  const call = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body as object } : {}) });
  const asOwner = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await ownerPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', 'owner', true)`, [ids.org, ids.owner]);
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  };
  const period = { periodStart: '2026-10-26', periodEnd: '2026-11-01', payDate: '2026-11-06', frequency: 'weekly' };

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: OWNER_URL });
    await asOwner(async (c) => {
      await c.query(`insert into organisations (id, legal_name, trading_name, paye_reference) values ($1, 'Kota King (Pty) Ltd', 'Kota King', '7000000000')`, [ids.org]);
      await c.query('insert into locations (id, org_id, name) values ($1, $2, $3)', [ids.loc, ids.org, 'Tembisa']);
      await c.query(`insert into users (id, display_name) values ($1, 'Owner'), ($2, 'Manager'), ($3, 'Payroll'), ($4, 'Thabo')`, [ids.owner, ids.manager, ids.payroll, ids.staffUser]);
      await c.query(
        `insert into employees (id, org_id, user_id, home_location_id, first_name, last_name, date_of_birth, employment_start) values
           ($1, $3, $4, $5, 'Thabo', 'Mahlangu', '1998-04-12', '2026-01-05'),
           ($2, $3, $6, $5, 'Grace', 'Manager', '1985-09-01', '2025-01-05')`,
        [ids.employee, ids.managerEmployee, ids.org, ids.staffUser, ids.loc, ids.manager],
      );
      await c.query(`insert into pay_rates (org_id, employee_id, rate_type, rate_cents, effective_from) values ($1, $2, 'hourly', 4000, '2026-01-01')`, [ids.org, ids.employee]);
      for (const d of ['2026-10-26', '2026-10-27', '2026-10-28']) {
        await c.query(
          `insert into time_entries (org_id, location_id, employee_id, clock_in, clock_out, method, idempotency_key, status) values ($1, $2, $3, $4, $5, 'manager', $6, 'approved')`,
          [ids.org, ids.loc, ids.employee, `${d}T09:00:00+02:00`, `${d}T17:00:00+02:00`, `pr-${randomUUID()}`],
        );
      }
      await c.query(`insert into tip_pools (id, org_id, location_id, name, strategy, effective_from) values ($1, $2, $3, 'Floor', 'hours_weighted', '2026-01-01')`, [ids.pool, ids.org, ids.loc]);
      await c.query(`insert into tip_distributions (org_id, tip_pool_id, business_date, employee_id, amount_cents) values ($1, $2, '2026-10-27', $3, 25000)`, [ids.org, ids.pool, ids.employee]);
    });
    const { db, pool } = createDb(APP_URL!);
    closeDb = () => pool.end();
    const verify = createVerifier(loadEnv({ NODE_ENV: 'test', DATABASE_URL: APP_URL!, AUTH_AUDIENCE: 'saas-rsa-api', AUTH_DEV_SECRET: SECRET }));
    app = buildApp({ db, verify, logLevel: 'silent', cipher: createFieldCipher({ AUTH_DEV_SECRET: SECRET }) });
    const sign = (userId: string, role: Role, loc = [ids.loc]) => signDevToken({ userId, role, orgId: ids.org, locationIds: loc }, SECRET);
    t.manager = await sign(ids.manager, 'general_manager');
    t.staff = await sign(ids.staffUser, 'employee');
    t.payroll = await sign(ids.payroll, 'payroll_admin', []);
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await ownerPool?.end();
  });

  let leaveId = '';

  it('works out BCEA leave balances', async () => {
    const res = await call(t.staff, 'GET', '/v1/leave/balances');
    expect(res.statusCode).toBe(200);
    const [annual, sick, family] = res.json().balances;
    expect(annual).toMatchObject({ type: 'annual', entitledMinutes: Math.floor(1440 / 17), dayMinutes: 540 });
    expect(sick).toMatchObject({ type: 'sick', entitledMinutes: 6 * 2700, cycle: { start: '2026-01-05', end: '2029-01-05' } });
    expect(family).toMatchObject({ type: 'family_responsibility', entitledMinutes: 3 * 540 });
  });

  it('lets staff ask for leave; a manager approves it, but not their own', async () => {
    const asked = await call(t.staff, 'POST', '/v1/leave/requests', { leaveType: 'annual', startsOn: '2026-10-29', endsOn: '2026-10-29', reason: 'Family wedding' });
    expect(asked.statusCode).toBe(201);
    expect(asked.json().request).toMatchObject({ minutes: 540, status: 'requested' });
    expect(asked.json().warnings).toHaveLength(1); // more than accrued so far
    leaveId = asked.json().request.id;

    expect((await call(t.staff, 'POST', `/v1/leave/requests/${leaveId}/approve`, {})).statusCode).toBe(403);
    expect((await call(t.staff, 'POST', '/v1/leave/requests', { employeeId: ids.managerEmployee, leaveType: 'annual', startsOn: '2026-11-10', endsOn: '2026-11-10' })).statusCode).toBe(403);
    const own = (await call(t.manager, 'POST', '/v1/leave/requests', { leaveType: 'annual', startsOn: '2026-11-20', endsOn: '2026-11-21' })).json().request;
    expect((await call(t.manager, 'POST', `/v1/leave/requests/${own.id}/approve`, {})).json().error.code).toBe('own_request');

    expect((await call(t.manager, 'POST', `/v1/leave/requests/${leaveId}/approve`, { note: 'Enjoy' })).json().request.status).toBe('approved');
    const annual = (await call(t.staff, 'GET', '/v1/leave/balances')).json().balances[0];
    expect(annual).toMatchObject({ takenMinutes: 540, availableMinutes: Math.floor(1440 / 17) - 540 });

    const sick = await call(t.staff, 'POST', '/v1/leave/requests', { leaveType: 'sick', startsOn: '2026-11-02', endsOn: '2026-11-04' });
    expect(sick.json().request).toMatchObject({ minutes: 3 * 540, medicalCertificateRequired: true });
    expect((await call(t.staff, 'GET', '/v1/leave/requests')).json().requests).toHaveLength(2); // only their own
  });

  it('only owners and payroll adjust balances', async () => {
    expect((await call(t.manager, 'POST', '/v1/leave/adjustments', { employeeId: ids.employee, leaveType: 'annual', minutes: 2400, reason: 'Opening balance from old system' })).statusCode).toBe(403);
    expect((await call(t.payroll, 'POST', '/v1/leave/adjustments', { employeeId: ids.employee, leaveType: 'annual', minutes: 2400, reason: 'Opening balance from old system' })).statusCode).toBe(201);
    const annual = (await call(t.payroll, 'GET', `/v1/leave/balances?employeeId=${ids.employee}`)).json().balances[0];
    expect(annual.availableMinutes).toBe(Math.floor(1440 / 17) + 2400 - 540);
  });

  let runId = '';
  let slipId = '';

  it('saves a draft run with hours, leave pay and tips; one run per period', async () => {
    const res = await call(t.payroll, 'POST', '/v1/payroll/runs', { ...period, employeeIds: [ids.employee] });
    expect(res.statusCode).toBe(201);
    runId = res.json().detail.run.id;
    const [slip] = res.json().detail.payslips;
    slipId = slip.id;
    const amount = (code: string) => slip.lines.find((l: { code: string }) => l.code === code)?.amountCents;
    expect(amount('ORDINARY')).toBe(96_000); // 24 h x R40
    expect(amount('LEAVE_ANNUAL')).toBe(36_000); // 9 h x R40
    expect(amount('TIPS')).toBe(25_000);
    expect(slip.grossCents).toBe(157_000);
    expect(res.json().detail.run.status).toBe('draft');
    expect((await call(t.payroll, 'POST', '/v1/payroll/runs', { ...period, employeeIds: [ids.employee] })).json().error.code).toBe('run_exists');
    expect((await call(t.manager, 'GET', '/v1/payroll/runs')).statusCode).toBe(403);
    expect((await call(t.payroll, 'GET', '/v1/payroll/runs')).json().runs).toEqual([expect.objectContaining({ id: runId, people: 1, netCents: slip.netCents })]);
  });

  it('keeps payslips from employees until the run is finalised', async () => {
    expect((await call(t.staff, 'GET', '/v1/me/payslips')).json().payslips).toEqual([]);
    expect((await call(t.staff, 'GET', `/v1/payslips/${slipId}/pdf`)).statusCode).toBe(404);
    expect((await call(t.payroll, 'POST', `/v1/payroll/runs/${runId}/finalise`)).json().error.code).toBe('not_approved');
    expect((await call(t.payroll, 'GET', `/v1/payroll/runs/${runId}/bank-file`)).json().error.code).toBe('not_finalised');
  });

  it('approves, finalises (linking tips and leave), and locks the run', async () => {
    expect((await call(t.payroll, 'POST', `/v1/payroll/runs/${runId}/approve`)).json().run.status).toBe('approved');
    expect((await call(t.payroll, 'POST', `/v1/payroll/runs/${runId}/finalise`)).json().run.status).toBe('finalised');

    const linked = await asOwner(async (c) => ({
      tips: (await c.query('select payroll_run_id from tip_distributions where employee_id = $1', [ids.employee])).rows[0].payroll_run_id,
      leave: (await c.query(`select payroll_run_id from leave_transactions where leave_request_id = $1`, [leaveId])).rows[0].payroll_run_id,
    }));
    expect(linked).toEqual({ tips: runId, leave: runId });

    // Paid tips and leave are not paid again.
    const again = (await call(t.payroll, 'POST', '/v1/payroll/preview', { ...period, employeeIds: [ids.employee] })).json().payslips[0];
    expect(again.lines.map((l: { code: string }) => l.code)).not.toContain('TIPS');
    expect(again.lines.map((l: { code: string }) => l.code)).not.toContain('LEAVE_ANNUAL');

    expect((await call(t.payroll, 'POST', `/v1/payroll/runs/${runId}/recalculate`)).json().error.code).toBe('locked');
    expect((await call(t.payroll, 'DELETE', `/v1/payroll/runs/${runId}`)).json().error.code).toBe('locked');
    await expect(asOwner((c) => c.query('update payslips set net_cents = 1, gross_cents = 1, deductions_cents = 0 where id = $1', [slipId]))).rejects.toThrow(/immutable/);
    expect((await call(t.manager, 'POST', `/v1/leave/requests/${leaveId}/cancel`)).json().error.code).toBe('already_paid');
  });

  it('gives the employee their payslip as a PDF', async () => {
    const mine = (await call(t.staff, 'GET', '/v1/me/payslips')).json().payslips;
    expect(mine).toEqual([expect.objectContaining({ id: slipId, payDate: '2026-11-06' })]);
    const pdf = await call(t.staff, 'GET', `/v1/payslips/${slipId}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.rawPayload.length).toBeGreaterThan(1500);
  });

  it('produces the bank file once everyone has bank details, then marks the run paid', async () => {
    const missing = await call(t.payroll, 'GET', `/v1/payroll/runs/${runId}/bank-file`);
    expect(missing.json().error).toMatchObject({ code: 'missing_bank_details', details: { missing: ['Thabo Mahlangu'] } });
    await call(t.payroll, 'PUT', `/v1/employees/${ids.employee}/personal`, {
      bank: { holder: 'T Mahlangu', bankName: 'FNB', branchCode: '250655', accountNumber: '62000000001', accountType: 'cheque' },
    });
    const file = await call(t.payroll, 'GET', `/v1/payroll/runs/${runId}/bank-file`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    const [header, row] = file.body.trim().split('\r\n');
    expect(header).toBe('Beneficiary name,Bank,Branch code,Account number,Account type,Account type code,Amount,Beneficiary reference,Own reference');
    const net = (await call(t.payroll, 'GET', `/v1/payroll/runs/${runId}`)).json().payslips[0].netCents;
    expect(row).toBe(`T Mahlangu,FNB,250655,62000000001,cheque,1,${(net / 100).toFixed(2)},Kota King SALARY,PAY 20261106`);
    expect((await call(t.payroll, 'POST', `/v1/payroll/runs/${runId}/paid`)).json().run.status).toBe('paid');
  });
});
