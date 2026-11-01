/**
 * Endpoints behind the manager and staff screens, against a real database.
 * Skipped when DATABASE_OWNER_URL / DATABASE_URL are not set.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Role } from '@saas-rsa/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createVerifier, signDevToken } from '../src/auth';
import { loadEnv } from '../src/env';
import { createFieldCipher } from '../src/crypto';

const OWNER_URL = process.env.DATABASE_OWNER_URL;
const APP_URL = process.env.DATABASE_URL;
const SECRET = 'test-secret-that-is-at-least-32-characters-long';

describe.skipIf(!OWNER_URL || !APP_URL)('workforce screens API', () => {
  const ids = {
    org: randomUUID(),
    loc: randomUUID(),
    owner: randomUUID(),
    manager: randomUUID(),
    staffUser: randomUUID(),
    staffUser2: randomUUID(),
    employee: randomUUID(),
    employee2: randomUUID(),
    role: randomUUID(),
  };
  let app: FastifyInstance;
  let ownerPool: pg.Pool;
  let closeDb: () => Promise<void>;
  const tokens = {} as Record<'manager' | 'staff' | 'staff2' | 'owner', string>;

  const call = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(body ? { payload: body as object } : {}) });

  // Shifts tomorrow and the day after, so they count as upcoming on /v1/me.
  const day = (offset: number, hour: number) => {
    const d = new Date(Date.now() + offset * 86_400_000);
    d.setUTCHours(hour - 2, 0, 0, 0); // hour in SAST
    return d.toISOString();
  };

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: OWNER_URL });
    const c = await ownerPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', 'owner', true)`, [ids.org, ids.owner]);
      await c.query('insert into organisations (id, legal_name) values ($1, $2)', [ids.org, 'Shisa Nyama (Pty) Ltd']);
      await c.query('insert into locations (id, org_id, name) values ($1, $2, $3)', [ids.loc, ids.org, 'Soweto']);
      await c.query(`insert into users (id, display_name) values ($1, 'Owner'), ($2, 'Thandi (manager)'), ($3, 'Bongani'), ($4, 'Zanele')`, [ids.owner, ids.manager, ids.staffUser, ids.staffUser2]);
      await c.query(
        `insert into memberships (org_id, user_id, role, location_ids) values
           ($1, $2, 'general_manager', array[$5::uuid]), ($1, $3, 'employee', array[$5::uuid]), ($1, $4, 'employee', array[$5::uuid])`,
        [ids.org, ids.manager, ids.staffUser, ids.staffUser2, ids.loc],
      );
      await c.query(`insert into job_roles (id, org_id, name, tip_group) values ($1, $2, 'Waiter', 'foh')`, [ids.role, ids.org]);
      await c.query(
        `insert into employees (id, org_id, user_id, home_location_id, job_role_id, first_name, last_name, date_of_birth, employment_start) values
           ($1, $3, $4, $6, $7, 'Bongani', 'Mokoena', '1999-03-02', '2026-01-05'),
           ($2, $3, $5, $6, $7, 'Zanele', 'Khumalo', null, '2026-01-05')`,
        [ids.employee, ids.employee2, ids.org, ids.staffUser, ids.staffUser2, ids.loc, ids.role],
      );
      await c.query(`insert into pay_rates (org_id, employee_id, rate_type, rate_cents, effective_from) values ($1, $2, 'hourly', 3800, '2026-01-01')`, [ids.org, ids.employee]);
      await c.query('commit');
    } finally {
      c.release();
    }

    const { db, pool } = createDb(APP_URL!);
    closeDb = () => pool.end();
    const verify = createVerifier(loadEnv({ NODE_ENV: 'test', DATABASE_URL: APP_URL!, AUTH_AUDIENCE: 'saas-rsa-api', AUTH_DEV_SECRET: SECRET }));
    app = buildApp({ db, verify, authActionSecret: 'x'.repeat(40), logLevel: 'silent', cipher: createFieldCipher({ AUTH_DEV_SECRET: SECRET }) });
    const sign = (userId: string, role: Role) => signDevToken({ userId, role, orgId: ids.org, locationIds: [ids.loc] }, SECRET);
    tokens.manager = await sign(ids.manager, 'general_manager');
    tokens.staff = await sign(ids.staffUser, 'employee');
    tokens.staff2 = await sign(ids.staffUser2, 'employee');
    tokens.owner = await sign(ids.owner, 'owner');
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await ownerPool?.end();
  });

  it('lists the team for a manager, with rates; an employee sees only themselves', async () => {
    const res = await call(tokens.manager, 'GET', `/v1/team?locationId=${ids.loc}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().employees.map((e: { firstName: string; rate: unknown; hasDateOfBirth: boolean }) => [e.firstName, e.rate, e.hasDateOfBirth])).toEqual([
      ['Bongani', { type: 'hourly', cents: 3800 }, true],
      ['Zanele', null, false],
    ]);
    expect(res.json().jobRoles).toEqual([{ id: ids.role, name: 'Waiter', tipGroup: 'foh' }]);

    const own = await call(tokens.staff, 'GET', `/v1/team?locationId=${ids.loc}`);
    expect(own.json().employees).toEqual([expect.objectContaining({ firstName: 'Bongani', rate: null })]);
  });

  let draftId = '';
  let publishedId = '';

  it('edits and deletes drafts; checks the BCEA without publishing (dry run)', async () => {
    const make = async (offset: number) =>
      (await call(tokens.manager, 'POST', '/v1/shifts', { locationId: ids.loc, employeeId: ids.employee, startsAt: day(offset, 10), endsAt: day(offset, 18), plannedBreakMinutes: 60 })).json().shift.id as string;
    draftId = await make(1);
    publishedId = await make(2);
    const spare = await make(3);

    const edited = await call(tokens.manager, 'PATCH', `/v1/shifts/${draftId}`, { endsAt: day(1, 17) });
    expect(edited.statusCode).toBe(200);
    expect(new Date(edited.json().shift.endsAt).toISOString()).toBe(day(1, 17));
    expect((await call(tokens.manager, 'PATCH', `/v1/shifts/${draftId}`, { endsAt: day(1, 9) })).statusCode).toBe(400);
    expect((await call(tokens.staff, 'PATCH', `/v1/shifts/${draftId}`, { endsAt: day(1, 16) })).statusCode).toBe(403);

    expect((await call(tokens.manager, 'DELETE', `/v1/shifts/${spare}`)).json()).toEqual({ deleted: true, cancelled: false });

    const dry = await call(tokens.manager, 'POST', '/v1/shifts/publish', { shiftIds: [draftId, publishedId], dryRun: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, published: 0, notified: 0 });
    const stillDraft = await call(tokens.manager, 'GET', `/v1/shifts?from=${encodeURIComponent(day(0, 0))}&to=${encodeURIComponent(day(4, 0))}&locationId=${ids.loc}`);
    expect(stillDraft.json().shifts.map((s: { status: string }) => s.status)).toEqual(['draft', 'draft']);

    const pub = await call(tokens.manager, 'POST', '/v1/shifts/publish', { shiftIds: [draftId, publishedId] });
    expect(pub.json()).toMatchObject({ published: 2, dryRun: false });
    expect((await call(tokens.manager, 'PATCH', `/v1/shifts/${draftId}`, { plannedBreakMinutes: 30 })).statusCode).toBe(409);
  });

  it("shows an employee their own day, and runs breaks on today's entry", async () => {
    const before = await call(tokens.staff, 'GET', '/v1/me');
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ employee: { id: ids.employee, firstName: 'Bongani', locationId: ids.loc }, openEntry: null });
    expect(before.json().shifts.map((s: { id: string }) => s.id)).toEqual([draftId, publishedId]);

    expect((await call(tokens.staff, 'POST', '/v1/me/break', { action: 'start' })).statusCode).toBe(409);
    const clockIn = await call(tokens.staff, 'POST', '/v1/time/clock-in', { employeeId: ids.employee, locationId: ids.loc, method: 'mobile' }, { 'idempotency-key': `me-${randomUUID()}` });
    expect(clockIn.statusCode).toBe(201);

    expect((await call(tokens.staff, 'POST', '/v1/me/break', { action: 'start' })).json()).toMatchObject({ replayed: false });
    expect((await call(tokens.staff, 'POST', '/v1/me/break', { action: 'start' })).json()).toMatchObject({ replayed: true });
    const during = (await call(tokens.staff, 'GET', '/v1/me')).json();
    expect(during.openEntry.breaks).toEqual([expect.objectContaining({ endsAt: null })]);
    expect((await call(tokens.staff, 'POST', '/v1/me/break', { action: 'end' })).statusCode).toBe(200);
    expect((await call(tokens.staff, 'POST', '/v1/me/break', { action: 'end' })).statusCode).toBe(409);

    // Another employee cannot see Bongani's entry, and has no shifts.
    expect((await call(tokens.staff2, 'GET', '/v1/me')).json()).toMatchObject({ openEntry: null, shifts: [] });

    await call(tokens.staff, 'POST', '/v1/time/clock-out', { timeEntryId: clockIn.json().entry.id });
    const after = (await call(tokens.staff, 'GET', '/v1/me')).json();
    expect(after.openEntry).toBeNull();
    expect(after.recentEntries).toHaveLength(1);
  });

  it('lists timesheets for approval with breaks and worked minutes', async () => {
    const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10); // SAST date
    const res = await call(tokens.manager, 'GET', `/v1/time?locationId=${ids.loc}&from=${today}&to=${today}`);
    expect(res.statusCode).toBe(200);
    const [entry] = res.json().entries;
    expect(entry).toMatchObject({ employeeId: ids.employee, status: 'submitted', method: 'mobile' });
    expect(entry.breaks).toHaveLength(1);
    expect(entry.workedMinutes).toBeGreaterThanOrEqual(0);
    expect((await call(tokens.staff, 'GET', `/v1/time?locationId=${ids.loc}&from=${today}&to=${today}`)).statusCode).toBe(403);
    expect((await call(tokens.manager, 'GET', `/v1/time?locationId=${ids.loc}&from=${today}&to=2020-01-01`)).statusCode).toBe(400);
  });

  it('cancels a published shift instead of deleting it', async () => {
    expect((await call(tokens.manager, 'DELETE', `/v1/shifts/${publishedId}`)).json()).toEqual({ deleted: false, cancelled: true });
    expect((await call(tokens.staff, 'GET', '/v1/me')).json().shifts.map((s: { id: string }) => s.id)).toEqual([draftId]);
  });

  it('creates tip pools with valid splits and shows a day of tips', async () => {
    const bad = await call(tokens.manager, 'POST', '/v1/tips/pools', { locationId: ids.loc, name: 'Floor', strategy: 'group_split_hours', groups: { foh: 0.7, boh: 0.2 } });
    expect(bad.statusCode).toBe(400);
    const ok = await call(tokens.manager, 'POST', '/v1/tips/pools', { locationId: ids.loc, name: 'Floor', strategy: 'group_split_hours', groups: { foh: 0.7, boh: 0.3 } });
    expect(ok.statusCode).toBe(201);
    expect((await call(tokens.manager, 'GET', `/v1/tips/pools?locationId=${ids.loc}`)).json().pools).toEqual([
      expect.objectContaining({ name: 'Floor', strategy: 'group_split_hours', config: { groups: { foh: 0.7, boh: 0.3 } } }),
    ]);
    await call(tokens.manager, 'POST', '/v1/tips/declare', { locationId: ids.loc, businessDate: '2026-10-30', source: 'cash', amountCents: 12_500 });
    const dayTips = await call(tokens.manager, 'GET', `/v1/tips?locationId=${ids.loc}&businessDate=2026-10-30`);
    expect(dayTips.json()).toMatchObject({ declared: [expect.objectContaining({ source: 'cash', amountCents: 12_500 })], distributed: [] });
    expect((await call(tokens.staff, 'GET', `/v1/tips/pools?locationId=${ids.loc}`)).statusCode).toBe(403);
  });

  it('lists log book entries with author, first-written time and acknowledgements', async () => {
    const created = (await call(tokens.manager, 'POST', '/v1/logbook', { locationId: ids.loc, category: 'handover', body: 'Gas delivery due 07:00', requiresAck: true })).json().entry;
    await call(tokens.manager, 'POST', `/v1/logbook/${created.entryGroupId}/revisions`, { body: 'Gas delivery moved to 08:00' });
    let [entry] = (await call(tokens.manager, 'GET', `/v1/logbook?locationId=${ids.loc}`)).json().entries;
    expect(entry).toMatchObject({ revision: 2, body: 'Gas delivery moved to 08:00', authorName: 'Thandi (manager)', firstAuthorName: 'Thandi (manager)', ackCount: 0, acknowledgedByMe: false });
    expect(new Date(entry.firstWrittenAt).getTime()).toBe(new Date(created.createdAt).getTime());

    await call(tokens.manager, 'POST', `/v1/logbook/entries/${entry.id}/ack`);
    [entry] = (await call(tokens.manager, 'GET', `/v1/logbook?locationId=${ids.loc}`)).json().entries;
    expect(entry).toMatchObject({ ackCount: 1, acknowledgedByMe: true });
  });

  it('encrypts ID, tax and bank numbers; shows them masked; logs every reveal', async () => {
    const url = `/v1/employees/${ids.employee2}/personal`;
    expect((await call(tokens.manager, 'PUT', url, { taxNumber: '0123456782' })).statusCode).toBe(403);
    expect((await call(tokens.owner, 'PUT', url, { idNumber: '8001015009088' })).json().error.code).toBe('invalid_id_number');

    const saved = await call(tokens.owner, 'PUT', url, {
      idNumber: '0108190123084',
      taxNumber: '0123456782',
      bank: { holder: 'Z Khumalo', bankName: 'Capitec', branchCode: '470010', accountNumber: '1234 567 890', accountType: 'savings' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().personal).toMatchObject({
      idNumber: '••••••3084', taxNumber: '••••••6782', dateOfBirth: '2001-08-19', revealed: false,
      bank: { holder: 'Z Khumalo', bankName: 'Capitec', branchCode: '470010', accountType: 'savings', accountNumber: '••••••7890' },
    });

    // The database holds ciphertext only.
    const c = await ownerPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.org_id', $1, true), set_config('app.role', 'owner', true)`, [ids.org]);
      const row = (await c.query('select id_number_enc, bank_account_enc, tax_number_hint from employees where id = $1', [ids.employee2])).rows[0];
      await c.query('commit');
      expect(row.id_number_enc.toString('latin1')).not.toContain('0108190123084');
      expect(row.bank_account_enc.toString('latin1')).not.toContain('1234567890');
      expect(row.tax_number_hint).toBe('6782');
      const audit = (await c.query(`select action, after from audit_log where org_id = $1 and entity_id = $2 order by at`, [ids.org, ids.employee2])).rows;
      expect(JSON.stringify(audit)).not.toContain('0108190123084');
    } finally {
      c.release();
    }

    const revealed = await call(tokens.owner, 'GET', `${url}?reveal=true`);
    expect(revealed.json().personal).toMatchObject({ idNumber: '0108190123084', taxNumber: '0123456782', bank: { accountNumber: '1234567890' }, revealed: true });
    expect((await call(tokens.manager, 'GET', url)).statusCode).toBe(403);

    const team = (await call(tokens.owner, 'GET', `/v1/team?locationId=${ids.loc}`)).json().employees;
    expect(team.find((e: { firstName: string }) => e.firstName === 'Zanele')).toMatchObject({ hasIdNumber: true, hasTaxNumber: true, hasBankDetails: true, hasDateOfBirth: true });

    const c2 = await ownerPool.connect();
    try {
      await c2.query('begin');
      await c2.query(`select set_config('app.org_id', $1, true), set_config('app.role', 'owner', true)`, [ids.org]);
      const reveals = (await c2.query(`select count(*)::int as n from audit_log where org_id = $1 and action = 'employee.personal_revealed'`, [ids.org])).rows[0].n;
      await c2.query('commit');
      expect(reveals).toBe(1);
    } finally {
      c2.release();
    }
  });
});
