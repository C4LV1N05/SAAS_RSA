/**
 * End-to-end API flow against a real, migrated + seeded PostgreSQL.
 *   DATABASE_OWNER_URL=... DATABASE_URL=... pnpm --filter @saas-rsa/api test
 * Skipped when those variables are not set.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Role } from '@saas-rsa/db';
import { buildApp } from '../src/app';
import { createVerifier, signDevToken } from '../src/auth';
import type { FastifyInstance } from 'fastify';

const OWNER_URL = process.env.DATABASE_OWNER_URL;
const APP_URL = process.env.DATABASE_URL;
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const ACTION_SECRET = 'auth0-action-secret-at-least-32-characters';

describe.skipIf(!OWNER_URL || !APP_URL)('API flow', () => {
  const ids = {
    org: randomUUID(),
    orgB: randomUUID(),
    loc: randomUUID(),
    locB: randomUUID(),
    owner: randomUUID(),
    ownerB: randomUUID(),
    manager: randomUUID(),
    payroll: randomUUID(),
    staffUser: randomUUID(),
    employee: randomUUID(),
    role: randomUUID(),
    pool: randomUUID(),
  };
  const phone = `+2782${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  let app: FastifyInstance;
  let ownerPool: pg.Pool;
  let closeDb: () => Promise<void>;
  const tokens = {} as Record<'manager' | 'staff' | 'payroll' | 'ownerB', string>;

  const call = (token: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(body ? { payload: body as object } : {}) });

  beforeAll(async () => {
    const owner = new pg.Pool({ connectionString: OWNER_URL });
    ownerPool = owner;
    const asOwner = async (orgId: string, userId: string, sql: Array<[string, unknown[]]>) => {
      const c = await owner.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', 'owner', true)`, [orgId, userId]);
        for (const [q, p] of sql) await c.query(q, p);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    };
    await asOwner(ids.org, ids.owner, [
      ['insert into organisations (id, legal_name, sdl_liable) values ($1, $2, false)', [ids.org, 'Braai & Co (Pty) Ltd']],
      ['insert into users (id, display_name, phone_e164) values ($1, $2, null), ($3, $4, null), ($5, $6, null), ($7, $8, $9)', [
        ids.owner, 'Owner', ids.manager, 'Manager', ids.payroll, 'Payroll', ids.staffUser, 'Lerato', phone,
      ]],
      ['insert into locations (id, org_id, name, geofence_lat, geofence_lng, geofence_radius_m) values ($1, $2, $3, -26.1457, 28.0416, 200)', [ids.loc, ids.org, 'Rosebank']],
      [`insert into memberships (org_id, user_id, role, location_ids) values
          ($1, $2, 'owner', '{}'), ($1, $3, 'general_manager', array[$6::uuid]),
          ($1, $4, 'payroll_admin', '{}'), ($1, $5, 'employee', array[$6::uuid])`, [ids.org, ids.owner, ids.manager, ids.payroll, ids.staffUser, ids.loc]],
      ['insert into job_roles (id, org_id, name, tip_group) values ($1, $2, $3, $4)', [ids.role, ids.org, 'Waiter', 'foh']],
      [`insert into employees (id, org_id, user_id, home_location_id, job_role_id, first_name, last_name, date_of_birth, employment_start)
        values ($1, $2, $3, $4, $5, 'Lerato', 'Nkosi', '2001-05-14', '2026-01-05')`, [ids.employee, ids.org, ids.staffUser, ids.loc, ids.role]],
      [`insert into pay_rates (org_id, employee_id, rate_type, rate_cents, effective_from) values ($1, $2, 'hourly', 3500, '2026-01-01')`, [ids.org, ids.employee]],
      [`insert into tip_pools (id, org_id, location_id, name, strategy, config, effective_from) values ($1, $2, $3, 'Floor', 'group_split_hours', '{"groups":{"foh":0.7,"boh":0.3}}', '2026-01-01')`, [ids.pool, ids.org, ids.loc]],
    ]);
    await asOwner(ids.orgB, ids.ownerB, [
      ['insert into organisations (id, legal_name) values ($1, $2)', [ids.orgB, 'Other Group']],
      ['insert into users (id, display_name) values ($1, $2)', [ids.ownerB, 'Owner B']],
    ]);

    const { db, pool } = createDb(APP_URL!);
    closeDb = () => pool.end();
    const verify = createVerifier({
      NODE_ENV: 'test', PORT: 0, LOG_LEVEL: 'silent', DATABASE_URL: APP_URL!, AUTH_AUDIENCE: 'saas-rsa-api',
      AUTH_CLAIM_NAMESPACE: 'https://saas-rsa.app/', AUTH_DEV_SECRET: SECRET,
    });
    app = buildApp({ db, verify, authActionSecret: ACTION_SECRET, logLevel: 'silent' });

    const sign = (userId: string, role: Role, orgId = ids.org, locationIds = [ids.loc]) =>
      signDevToken({ userId, role, orgId, locationIds }, SECRET);
    tokens.manager = await sign(ids.manager, 'general_manager');
    tokens.staff = await sign(ids.staffUser, 'employee');
    tokens.payroll = await sign(ids.payroll, 'payroll_admin', ids.org, []);
    tokens.ownerB = await sign(ids.ownerB, 'owner', ids.orgB, []);
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await ownerPool?.end();
  });

  /** Read the outbox as the owner with the org's context (FORCE RLS applies to the owner too). */
  const outboxRows = async () => {
    const c = await ownerPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.org_id', $1, true), set_config('app.role', 'owner', true)`, [ids.org]);
      const r = await c.query('select template, recipient, params, status from notification_outbox');
      await c.query('commit');
      return r.rows;
    } finally {
      c.release();
    }
  };

  it('requires a token except for /health', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/shifts?from=2026-10-26&to=2026-11-02' })).statusCode).toBe(401);
    expect((await call('not-a-token', 'GET', '/v1/shifts?from=2026-10-26&to=2026-11-02')).statusCode).toBe(401);
  });

  it('stops an employee from creating shifts', async () => {
    const res = await call(tokens.staff, 'POST', '/v1/shifts', { locationId: ids.loc, startsAt: '2026-10-26T08:00:00+02:00', endsAt: '2026-10-26T16:00:00+02:00' });
    expect(res.statusCode).toBe(403);
  });

  it('blocks publishing overtime without an agreement, then publishes with a recorded override', async () => {
    const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
    const shiftIds: string[] = [];
    for (const d of days) {
      const res = await call(tokens.manager, 'POST', '/v1/shifts', {
        locationId: ids.loc, employeeId: ids.employee, startsAt: `${d}T08:00:00+02:00`, endsAt: `${d}T18:00:00+02:00`, plannedBreakMinutes: 60,
      });
      expect(res.statusCode).toBe(201);
      shiftIds.push(res.json().shift.id);
    }
    const sat = await call(tokens.manager, 'POST', '/v1/shifts', {
      locationId: ids.loc, employeeId: ids.employee, startsAt: '2026-10-31T08:00:00+02:00', endsAt: '2026-10-31T11:00:00+02:00',
    });
    shiftIds.push(sat.json().shift.id);

    const blocked = await call(tokens.manager, 'POST', '/v1/shifts/publish', { shiftIds });
    expect(blocked.statusCode).toBe(422);
    const findings = blocked.json().error.details.findings;
    expect(findings.map((f: { ruleKey: string }) => f.ruleKey)).toEqual(['bcea.overtime_agreement']);

    const ok = await call(tokens.manager, 'POST', '/v1/shifts/publish', {
      shiftIds,
      overrides: [{ ruleKey: 'bcea.overtime_agreement', subjectId: findings[0].subjectId, reason: 'Signed overtime agreement being uploaded today' }],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ published: 6, notified: 1 });
    // The message is queued in the outbox, committed with the publish.
    expect(await outboxRows()).toEqual([
      expect.objectContaining({ template: 'schedule_published', status: 'queued', recipient: expect.objectContaining({ phoneE164: phone }), params: { shifts: 6 } }),
    ]);

    const staffView = await call(tokens.staff, 'GET', '/v1/shifts?from=2026-10-26T00:00:00%2B02:00&to=2026-11-02T00:00:00%2B02:00');
    expect(staffView.json().shifts).toHaveLength(6);
  });

  let entryId = '';

  it('clocks in idempotently and flags clock-ins outside the geofence', async () => {
    const body = { employeeId: ids.employee, locationId: ids.loc, method: 'mobile', gps: { lat: -33.9249, lng: 18.4241 } };
    const first = await call(tokens.staff, 'POST', '/v1/time/clock-in', body, { 'idempotency-key': 'clock-in-key-0001' });
    expect(first.statusCode).toBe(201);
    expect(first.json().warnings).toEqual(['outside_geofence']);
    entryId = first.json().entry.id;

    const retry = await call(tokens.staff, 'POST', '/v1/time/clock-in', body, { 'idempotency-key': 'clock-in-key-0001' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ replayed: true, entry: { id: entryId } });

    const second = await call(tokens.staff, 'POST', '/v1/time/clock-in', body, { 'idempotency-key': 'clock-in-key-0002' });
    expect(second.statusCode).toBe(409);
  });

  it('clocks out, takes a manager correction, and approves', async () => {
    expect((await call(tokens.staff, 'POST', '/v1/time/clock-out', { timeEntryId: entryId })).json().entry.status).toBe('submitted');
    // Manager corrects to the actual shift (Tue 27 Oct 08:00-17:00) with a reason, and records lunch.
    const edit = await call(tokens.manager, 'PATCH', `/v1/time/${entryId}`, {
      clockIn: '2026-10-27T08:00:00+02:00', clockOut: '2026-10-27T17:00:00+02:00', reason: 'Phone was off during load-shedding',
    });
    expect(edit.statusCode).toBe(200);
    await call(tokens.manager, 'POST', `/v1/time/${entryId}/breaks`, { startsAt: '2026-10-27T12:00:00+02:00', endsAt: '2026-10-27T13:00:00+02:00' });

    expect((await call(tokens.staff, 'POST', `/v1/time/${entryId}/approve`)).statusCode).toBe(403);
    const approved = await call(tokens.manager, 'POST', `/v1/time/${entryId}/approve`);
    expect(approved.json().entry).toMatchObject({ status: 'approved', approvedBy: ids.manager });
  });

  it('checks the worked week against the BCEA', async () => {
    const res = await call(tokens.manager, 'POST', '/v1/compliance/employee-week', { employeeId: ids.employee, date: '2026-10-29' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ week: '2026-10-26', totals: { workedMinutes: 480, ordinaryMinutes: 480 }, findings: [], blocked: false });
  });

  it('distributes a day of tips once', async () => {
    await call(tokens.manager, 'POST', '/v1/tips/declare', { locationId: ids.loc, businessDate: '2026-10-27', source: 'card', amountCents: 50_000 });
    const res = await call(tokens.manager, 'POST', '/v1/tips/distribute', { tipPoolId: ids.pool, businessDate: '2026-10-27', commit: true });
    expect(res.json().shares).toEqual([expect.objectContaining({ employeeId: ids.employee, amountCents: 50_000 })]);
    expect((await call(tokens.manager, 'POST', '/v1/tips/distribute', { tipPoolId: ids.pool, businessDate: '2026-10-27', commit: true })).statusCode).toBe(409);
  });

  it('previews a weekly payslip and EMP201 values', async () => {
    const res = await call(tokens.payroll, 'POST', '/v1/payroll/preview', {
      employeeIds: [ids.employee], periodStart: '2026-10-26', periodEnd: '2026-11-01', payDate: '2026-11-06', frequency: 'weekly',
    });
    expect(res.statusCode).toBe(200);
    const [slip] = res.json().payslips;
    const amount = (code: string) => slip.lines.find((l: { code: string }) => l.code === code)?.amountCents;
    expect(amount('ORDINARY')).toBe(28_000); // 8 h x R35
    expect(amount('TIPS')).toBe(50_000);
    expect(amount('PAYE')).toBe(0); // R780 x 52 is below the tax threshold
    expect(amount('UIF_EMPLOYEE')).toBe(280); // 1% of wages only
    expect(slip.netCents).toBe(78_000 - 280);
    expect(res.json().emp201).toMatchObject({ uifCents: 560, payeCents: 0 });
    expect((await call(tokens.manager, 'POST', '/v1/payroll/preview', { employeeIds: [ids.employee], periodStart: '2026-10-26', periodEnd: '2026-11-01', payDate: '2026-11-06', frequency: 'weekly' })).statusCode).toBe(403);
  });

  it('keeps a hash-chained, revisable log book', async () => {
    const created = await call(tokens.manager, 'POST', '/v1/logbook', { locationId: ids.loc, category: 'maintenance', body: 'Extractor fan noisy', requiresAck: true });
    expect(created.statusCode).toBe(201);
    const { entryGroupId, id } = created.json().entry;
    const revised = await call(tokens.manager, 'POST', `/v1/logbook/${entryGroupId}/revisions`, { body: 'Extractor fan noisy; technician booked Thursday' });
    expect(revised.json().entry).toMatchObject({ revision: 2, seq: 2 });

    const list = await call(tokens.manager, 'GET', `/v1/logbook?locationId=${ids.loc}`);
    expect(list.json().entries).toHaveLength(1);
    expect(list.json().entries[0].revision).toBe(2);

    expect((await call(tokens.manager, 'POST', `/v1/logbook/entries/${id}/ack`)).json()).toEqual({ acknowledged: true });
    expect((await call(tokens.manager, 'GET', `/v1/logbook/verify?locationId=${ids.loc}`)).json()).toMatchObject({ valid: true, entries: 2 });
    expect((await call(tokens.payroll, 'GET', `/v1/logbook?locationId=${ids.loc}`)).statusCode).toBe(403);
  });

  it("cannot see another organisation's employees", async () => {
    const res = await call(tokens.ownerB, 'POST', '/v1/compliance/employee-week', { employeeId: ids.employee, date: '2026-10-27' });
    expect(res.statusCode).toBe(404);
  });

  describe('Auth0 claims endpoint', () => {
    const claims = (body: object, secret = ACTION_SECRET) =>
      app.inject({ method: 'POST', url: '/internal/auth/claims', headers: { 'x-internal-secret': secret }, payload: body });

    it('rejects a wrong secret', async () => {
      expect((await claims({ sub: 'sms|1' }, 'x'.repeat(40))).statusCode).toBe(401);
    });

    it('links an invited employee by verified phone on first login, then by subject', async () => {
      const sub = `sms|${randomUUID()}`;
      const first = await claims({ sub, phone, phoneVerified: true });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ userId: ids.staffUser, orgId: ids.org, role: 'employee', locationIds: [ids.loc] });
      // Second login: found by the linked subject, no phone needed.
      expect((await claims({ sub })).json()).toMatchObject({ userId: ids.staffUser });
    });

    it('does not link by an unverified phone', async () => {
      expect((await claims({ sub: `sms|${randomUUID()}`, phone: '+27829999999', phoneVerified: false })).statusCode).toBe(403);
    });

    it('denies logins with no membership', async () => {
      expect((await claims({ sub: `auth0|${randomUUID()}`, email: 'stranger@example.com', emailVerified: true })).statusCode).toBe(403);
    });
  });
});
