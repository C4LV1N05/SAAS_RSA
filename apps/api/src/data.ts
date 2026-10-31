/** Query helpers shared by routes. Every function runs inside a tenant transaction. */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, ne } from 'drizzle-orm';
import { schema, type TenantContext, type Tx } from '@saas-rsa/db';
import type { EmployeeWorkProfile, WorkInterval } from '@saas-rsa/domain';
import { HttpError, notFound } from './errors';

const { employees, payRates, shifts, timeEntries, timeEntryBreaks, auditLog } = schema;

export type EmployeeRow = typeof employees.$inferSelect;

export async function getEmployee(tx: Tx, id: string): Promise<EmployeeRow> {
  const [row] = await tx.select().from(employees).where(eq(employees.id, id));
  if (!row) throw notFound('Employee');
  return row;
}

export function workProfile(e: EmployeeRow): EmployeeWorkProfile {
  return {
    daysPerWeek: e.daysPerWeek,
    ordinarilyWorksSundays: e.ordinarilyWorksSundays,
    overtimeAgreement: e.overtimeAgreement,
    mealIntervalMinutes: e.mealIntervalMinutes === 30 ? 30 : 60,
    bceaThresholdExempt: e.bceaThresholdExempt,
  };
}

/** The hourly rate in force on a date (review fix #5: rates are dated). */
export async function hourlyRateOn(tx: Tx, employeeId: string, onDate: string): Promise<number> {
  const [rate] = await tx
    .select()
    .from(payRates)
    .where(and(eq(payRates.employeeId, employeeId), lte(payRates.effectiveFrom, onDate)))
    .orderBy(desc(payRates.effectiveFrom))
    .limit(1);
  if (!rate) throw new HttpError(422, 'no_pay_rate', `No pay rate in force on ${onDate}`);
  if (rate.rateType !== 'hourly') {
    throw new HttpError(422, 'unsupported_rate', 'Salaried pay is not supported by this endpoint yet');
  }
  return rate.rateCents;
}

/**
 * Planned shifts as work intervals; a planned break is placed mid-shift as unpaid.
 * Published shifts are always included; drafts only when listed in includeDrafts.
 */
export async function shiftIntervals(
  tx: Tx,
  employeeId: string,
  from: Date,
  to: Date,
  includeDrafts: ReadonlySet<string> = new Set(),
): Promise<WorkInterval[]> {
  const rows = await tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.employeeId, employeeId), ne(shifts.status, 'cancelled'), lt(shifts.startsAt, to), gte(shifts.endsAt, from)))
    .orderBy(asc(shifts.startsAt));
  return rows.filter((s) => s.status === 'published' || includeDrafts.has(s.id)).map((s) => {
    const interval: WorkInterval = { id: s.id, start: s.startsAt, end: s.endsAt };
    if (s.plannedBreakMinutes > 0) {
      const mid = (s.startsAt.getTime() + s.endsAt.getTime()) / 2;
      const half = (s.plannedBreakMinutes * 60_000) / 2;
      interval.breaks = [{ start: new Date(mid - half), end: new Date(mid + half), paid: false }];
    }
    return interval;
  });
}

/** Closed time entries (with breaks) as work intervals. */
export async function timeIntervals(
  tx: Tx,
  employeeId: string,
  from: Date,
  to: Date,
  statuses: string[] = ['approved'],
): Promise<WorkInterval[]> {
  const rows = await tx
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.employeeId, employeeId),
        inArray(timeEntries.status, statuses),
        isNotNull(timeEntries.clockOut),
        gte(timeEntries.clockIn, from),
        lt(timeEntries.clockIn, to),
      ),
    )
    .orderBy(asc(timeEntries.clockIn));
  if (rows.length === 0) return [];
  const breaks = await tx
    .select()
    .from(timeEntryBreaks)
    .where(and(inArray(timeEntryBreaks.timeEntryId, rows.map((r) => r.id)), isNotNull(timeEntryBreaks.endsAt)));
  return rows.map((r) => ({
    id: r.id,
    start: r.clockIn,
    end: r.clockOut!,
    breaks: breaks.filter((b) => b.timeEntryId === r.id).map((b) => ({ start: b.startsAt, end: b.endsAt!, paid: b.paid })),
  }));
}

export async function audit(
  tx: Tx,
  auth: TenantContext,
  entry: { action: string; entity: string; entityId?: string; before?: unknown; after?: unknown; reason?: string },
): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: auth.orgId,
    actorUserId: auth.userId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
  });
}
