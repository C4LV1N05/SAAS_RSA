/**
 * Workforce data for the demo restaurant: roles, pay rates, last week (worked,
 * tips shared), this week (published), with the last two days' clock times
 * waiting for approval, next week drafted (with one BCEA problem to resolve), tips to
 * share for yesterday, and a few log book entries on a valid hash chain.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { computeLogHash, GENESIS_HASH, type LogHashInput } from '@saas-rsa/domain';

const DAY = 86_400_000;
const sastToday = () => new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monday = (d: string) => {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return addDays(d, dow === 0 ? -6 : 1 - dow);
};
const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+02:00`);

interface Ids {
  org: string;
  loc: string;
  users: { owner: string; manager: string; waiter: string; chef: string };
  employees: { waiter: string; chef: string; waiter2: string };
}

/** Weekly patterns: weekday index (0 = Monday) -> [start, end, unpaid break minutes]. */
const PATTERNS: Record<'waiter' | 'chef' | 'waiter2' | 'bar', Record<number, [string, string, number]>> = {
  waiter: { 0: ['11:00', '19:00', 60], 1: ['11:00', '19:00', 60], 3: ['15:00', '23:00', 60], 4: ['15:00', '23:00', 60], 5: ['12:00', '20:00', 60] },
  chef: { 1: ['09:00', '17:30', 30], 2: ['09:00', '17:30', 30], 3: ['09:00', '17:30', 30], 4: ['14:00', '22:30', 30], 5: ['14:00', '22:30', 30] },
  waiter2: { 2: ['11:00', '19:00', 60], 3: ['11:00', '19:00', 60], 4: ['17:00', '23:00', 0], 5: ['17:00', '23:00', 0], 6: ['10:00', '16:00', 30] },
  bar: { 3: ['16:00', '23:30', 30], 4: ['16:00', '23:30', 30], 5: ['16:00', '23:30', 30] },
};

export async function seedWorkforce(c: pg.PoolClient, ids: Ids): Promise<{ bartender: string }> {
  const { org, loc } = ids;
  const role = async (name: string, group: string, points = 1) =>
    (await c.query('insert into job_roles (org_id, name, tip_group, tip_points) values ($1, $2, $3, $4) returning id', [org, name, group, points])).rows[0].id as string;
  const waiterRole = await role('Waiter', 'foh');
  const chefRole = await role('Chef', 'boh', 1.2);
  const barRole = await role('Bartender', 'foh');

  await c.query('update employees set job_role_id = $1, date_of_birth = $2 where id = $3', [waiterRole, '2001-08-19', ids.employees.waiter]);
  await c.query('update employees set job_role_id = $1, date_of_birth = $2 where id = $3', [chefRole, '1994-02-07', ids.employees.chef]);
  await c.query('update employees set job_role_id = $1, date_of_birth = $2 where id = $3', [waiterRole, '2003-11-30', ids.employees.waiter2]);
  // Lindiwe has no date of birth yet, so payroll shows what is missing.
  const bartender = (await c.query(
    `insert into employees (org_id, home_location_id, job_role_id, first_name, last_name, employment_start) values ($1, $2, $3, 'Lindiwe', 'Ndlovu', '2026-06-01') returning id`,
    [org, loc, barRole],
  )).rows[0].id as string;

  for (const [emp, cents] of [[ids.employees.waiter, 3_250], [ids.employees.chef, 4_800], [ids.employees.waiter2, 3_100], [bartender, 3_500]] as const) {
    await c.query(`insert into pay_rates (org_id, employee_id, rate_type, rate_cents, effective_from) values ($1, $2, 'hourly', $3, '2026-03-01')`, [org, emp, cents]);
  }
  await c.query(
    `insert into memberships (org_id, user_id, role, location_ids) values
       ($1, $2, 'owner', '{}'), ($1, $3, 'general_manager', array[$6::uuid]), ($1, $4, 'employee', array[$6::uuid]), ($1, $5, 'employee', array[$6::uuid])`,
    [org, ids.users.owner, ids.users.manager, ids.users.waiter, ids.users.chef, loc],
  );

  const today = sastToday();
  const thisWeek = monday(today);
  const lastWeek = addDays(thisWeek, -7);
  const nextWeek = addDays(thisWeek, 7);
  const now = Date.now();
  const people = [
    [ids.employees.waiter, PATTERNS.waiter],
    [ids.employees.chef, PATTERNS.chef],
    [ids.employees.waiter2, PATTERNS.waiter2],
    [bartender, PATTERNS.bar],
  ] as const;

  const shift = async (emp: string | null, start: Date, end: Date, brk: number, status: 'draft' | 'published') =>
    (await c.query(
      `insert into shifts (org_id, location_id, employee_id, starts_at, ends_at, planned_break_minutes, status, published_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [org, loc, emp, start, end, brk, status, status === 'published' ? new Date(now - 6 * DAY) : null],
    )).rows[0].id as string;

  let n = 0;
  // Entries from the last two days wait for approval; older ones are already approved.
  const clock = async (emp: string, shiftId: string, start: Date, end: Date, brk: number) => {
    n += 1;
    // Small, realistic drift; every seventh entry is a late arrival worth a look.
    const drift = (n % 7 === 0 ? 18 : (n % 3) - 1) * 60_000;
    const clockIn = new Date(start.getTime() + drift);
    const clockOut = new Date(end.getTime() + ((n % 4) - 1) * 60_000);
    if (clockOut.getTime() > now) return;
    const approved = clockOut.getTime() < now - 2 * DAY;
    const id = (await c.query(
      `insert into time_entries (org_id, location_id, employee_id, shift_id, clock_in, clock_out, method, idempotency_key, status, approved_by, approved_at)
       values ($1,$2,$3,$4,$5,$6,'mobile',$7,$8,$9,$10) returning id`,
      [org, loc, emp, shiftId, clockIn, clockOut, `demo-${randomUUID()}`, approved ? 'approved' : 'submitted', approved ? ids.users.manager : null, approved ? new Date(now - 2 * DAY) : null],
    )).rows[0].id as string;
    if (brk > 0) {
      const mid = (start.getTime() + end.getTime()) / 2;
      await c.query('insert into time_entry_breaks (org_id, time_entry_id, starts_at, ends_at, paid) values ($1, $2, $3, $4, false)', [
        org, id, new Date(mid - (brk * 60_000) / 2), new Date(mid + (brk * 60_000) / 2),
      ]);
    }
  };

  const span = (d: string, [s, e]: [string, string, number]) => {
    const start = at(d, s);
    let end = at(d, e);
    if (end <= start) end = new Date(end.getTime() + DAY);
    return { start, end };
  };

  for (const [emp, pattern] of people) {
    for (let i = 0; i < 7; i++) {
      // Last week: published and worked.
      const p = pattern[i];
      if (p) {
        const d = addDays(lastWeek, i);
        const { start, end } = span(d, p);
        const id = await shift(emp, start, end, p[2], 'published');
        await clock(emp, id, start, end, p[2]);
      }
      // This week: published; days already worked are waiting for approval.
      const d = addDays(thisWeek, i);
      if (emp === ids.employees.waiter && d === today) continue; // Ayanda's shift today is added below
      if (p) {
        const { start, end } = span(d, p);
        const id = await shift(emp, start, end, p[2], 'published');
        await clock(emp, id, start, end, p[2]);
      }
    }
  }

  // Ayanda is due on now, so her phone screen offers "Clock in".
  const hour = Math.max(0, new Date(now + 2 * 3_600_000).getUTCHours() - 1);
  const start = at(today, `${String(hour).padStart(2, '0')}:00`);
  await shift(ids.employees.waiter, start, new Date(start.getTime() + 8 * 3_600_000), 60, 'published');

  // Next week: drafted. Sipho's long days add up to more than 45 ordinary hours with no
  // overtime agreement on file, so publishing asks for a fix or a recorded reason.
  for (const [emp, pattern] of people) {
    for (let i = 0; i < 7; i++) {
      const p = pattern[i];
      if (!p) continue;
      const d = addDays(nextWeek, i);
      const times: [string, string, number] = emp === ids.employees.chef ? ['09:00', '20:00', 60] : p;
      const { start: s, end: e } = span(d, times);
      await shift(emp, s, e, times[2], 'draft');
    }
  }
  await shift(null, at(addDays(nextWeek, 5), '18:00'), at(addDays(nextWeek, 5), '23:00'), 0, 'draft');

  // Tips: one pool, last Friday and Saturday shared out, yesterday waiting to be shared.
  const pool = (await c.query(
    `insert into tip_pools (org_id, location_id, name, strategy, config, effective_from) values ($1, $2, 'Floor and kitchen', 'group_split_hours', '{"groups":{"foh":0.7,"boh":0.3}}', '2026-03-01') returning id`,
    [org, loc],
  )).rows[0].id as string;
  for (const [offset, shares] of [[4, [[ids.employees.waiter, 41_000, 'foh'], [ids.employees.waiter2, 36_500, 'foh'], [ids.employees.chef, 33_000, 'boh']]], [5, [[ids.employees.waiter, 52_000, 'foh'], [ids.employees.waiter2, 47_500, 'foh'], [ids.employees.chef, 42_500, 'boh']]]] as const) {
    for (const [emp, cents, group] of shares) {
      await c.query(
        'insert into tip_distributions (org_id, tip_pool_id, business_date, employee_id, amount_cents, basis) values ($1, $2, $3, $4, $5, $6)',
        [org, pool, addDays(lastWeek, offset), emp, cents, { strategy: 'group_split_hours', minutes: 420, weight: 1, group }],
      );
    }
  }
  const yesterday = addDays(today, -1);
  await c.query(
    `insert into shift_tips (org_id, location_id, business_date, source, amount_cents, declared_by) values ($1, $2, $3, 'cash', 64000, $4), ($1, $2, $3, 'card', 118050, $4)`,
    [org, loc, yesterday, ids.users.manager],
  );

  // Log book: a valid hash chain, including one corrected entry.
  let seq = 0;
  let prev = GENESIS_HASH;
  const log = async (group: string, revision: number, category: string, body: string, requiresAck: boolean, minutesAgo: number) => {
    seq += 1;
    const createdAt = new Date(Math.floor((now - minutesAgo * 60_000) / 1000) * 1000);
    const input: LogHashInput = {
      orgId: org, locationId: loc, entryGroupId: group, revision, seq, authorUserId: ids.users.manager,
      category, body, attachments: [], shiftId: null, employeeId: null, createdAt: createdAt.toISOString(),
    };
    const hash = computeLogHash(prev, input);
    await c.query(
      `insert into manager_logs (org_id, location_id, entry_group_id, revision, author_user_id, category, requires_ack, body, attachments, seq, prev_hash, hash, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'[]',$9,$10,$11,$12)`,
      [org, loc, group, revision, ids.users.manager, category, requiresAck, body, seq, prev, hash, createdAt],
    );
    prev = hash;
  };
  const fridge = randomUUID();
  await log(randomUUID(), 1, 'incident', 'Guest at T4 slipped near the bar after a spill. No injury; area mopped and a wet-floor sign placed. Witness: Kagiso.', false, 60 * 30);
  await log(fridge, 1, 'maintenance', 'Walk-in fridge reading 7°C at close. Technician called.', true, 60 * 26);
  await log(fridge, 2, 'maintenance', 'Walk-in fridge reading 7°C at close. Technician came at 08:00, replaced the door seal; back to 3°C.', true, 60 * 20);
  await log(randomUUID(), 1, 'handover', 'Load-shedding stage 2 tonight 18:00–20:30. Generator fuelled; switch the card machines to the backup router.', true, 90);

  return { bartender };
}
