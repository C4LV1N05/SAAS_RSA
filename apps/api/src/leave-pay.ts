/**
 * Leave balances and leave pay, read from the database and worked out with the
 * BCEA rules in packages/domain/src/leave.
 */
import { and, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { schema, type Tx } from '@saas-rsa/db';
import {
  addMonths,
  annualAccrualMinutes,
  dailyMinutes,
  familyEntitlement,
  localMidnight,
  sickEntitlement,
  workedMinutes,
  type LeaveProfile,
  type LeaveType,
  type PayslipLine,
} from '@saas-rsa/domain';
import type { EmployeeRow } from './data';

const { leaveTransactions, timeEntries, timeEntryBreaks } = schema;

export const LEAVE_LABEL: Record<LeaveType, string> = {
  annual: 'Annual leave',
  sick: 'Sick leave',
  family_responsibility: 'Family responsibility leave',
};

export const profileOf = (e: EmployeeRow): LeaveProfile => ({
  employmentStart: e.employmentStart,
  daysPerWeek: e.daysPerWeek,
  standardWeeklyMinutes: e.standardWeeklyMinutes,
});

/** Approved worked minutes and distinct days worked between two dates (inclusive start, exclusive end). */
async function worked(tx: Tx, employeeId: string, from: string, to: string): Promise<{ minutes: number; days: number }> {
  const rows = await tx
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.employeeId, employeeId),
        eq(timeEntries.status, 'approved'),
        gte(timeEntries.clockIn, localMidnight(from)),
        lt(timeEntries.clockIn, localMidnight(to)),
      ),
    );
  if (!rows.length) return { minutes: 0, days: 0 };
  const breaks = await tx.select().from(timeEntryBreaks).where(inArray(timeEntryBreaks.timeEntryId, rows.map((r) => r.id)));
  let minutes = 0;
  const days = new Set<string>();
  for (const r of rows) {
    if (!r.clockOut) continue;
    minutes += workedMinutes({
      id: r.id,
      start: r.clockIn,
      end: r.clockOut,
      breaks: breaks.filter((b) => b.timeEntryId === r.id && b.endsAt).map((b) => ({ start: b.startsAt, end: b.endsAt!, paid: b.paid })),
    });
    days.add(new Date(r.clockIn.getTime() + 2 * 3_600_000).toISOString().slice(0, 10));
  }
  return { minutes, days: days.size };
}

async function ledger(tx: Tx, employeeId: string, type: LeaveType, from?: string, to?: string) {
  const [row] = await tx
    .select({
      taken: sql<number>`coalesce(sum(case when ${leaveTransactions.source} = 'taken' then -${leaveTransactions.minutes} else 0 end), 0)::int`,
      adjusted: sql<number>`coalesce(sum(case when ${leaveTransactions.source} = 'adjustment' then ${leaveTransactions.minutes} else 0 end), 0)::int`,
    })
    .from(leaveTransactions)
    .where(
      and(
        eq(leaveTransactions.employeeId, employeeId),
        eq(leaveTransactions.leaveType, type),
        ...(from ? [gte(leaveTransactions.occurredOn, from)] : []),
        ...(to ? [lt(leaveTransactions.occurredOn, to)] : []),
      ),
    );
  return { taken: row?.taken ?? 0, adjusted: row?.adjusted ?? 0 };
}

export interface LeaveBalance {
  type: LeaveType;
  label: string;
  /** Minutes still available. */
  availableMinutes: number;
  entitledMinutes: number;
  takenMinutes: number;
  dayMinutes: number;
  cycle?: { start: string; end: string };
  note?: string;
}

export async function leaveBalances(tx: Tx, e: EmployeeRow, asOf: string): Promise<LeaveBalance[]> {
  const p = profileOf(e);
  const day = dailyMinutes(p);
  const tomorrow = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  // Annual: accrued from approved hours since employment started, plus adjustments, less taken.
  const all = await worked(tx, e.id, e.employmentStart, tomorrow);
  const annual = await ledger(tx, e.id, 'annual');
  const accrued = annualAccrualMinutes(all.minutes) + annual.adjusted;

  // Sick: per 36-month cycle; in the first six months, 1 day per 26 days worked.
  const firstSix = asOf < addMonths(e.employmentStart, 6) ? (await worked(tx, e.id, e.employmentStart, tomorrow)).days : 0;
  const sick = sickEntitlement(p, asOf, firstSix);
  const sickLedger = await ledger(tx, e.id, 'sick', sick.cycleStart, sick.cycleEnd);

  const family = familyEntitlement(p, asOf);
  const familyLedger = await ledger(tx, e.id, 'family_responsibility', family.cycleStart, family.cycleEnd);

  return [
    {
      type: 'annual',
      label: LEAVE_LABEL.annual,
      entitledMinutes: accrued,
      takenMinutes: annual.taken,
      availableMinutes: accrued - annual.taken,
      dayMinutes: day,
      note: 'Earned at 1 hour for every 17 hours worked',
    },
    {
      type: 'sick',
      label: LEAVE_LABEL.sick,
      entitledMinutes: sick.entitledMinutes + sickLedger.adjusted,
      takenMinutes: sickLedger.taken,
      availableMinutes: sick.entitledMinutes + sickLedger.adjusted - sickLedger.taken,
      dayMinutes: day,
      cycle: { start: sick.cycleStart, end: sick.cycleEnd },
      ...(sick.probationary ? { note: 'First six months: 1 day for every 26 days worked' } : {}),
    },
    {
      type: 'family_responsibility',
      label: LEAVE_LABEL.family_responsibility,
      entitledMinutes: family.entitledMinutes + familyLedger.adjusted,
      takenMinutes: familyLedger.taken,
      availableMinutes: family.entitledMinutes + familyLedger.adjusted - familyLedger.taken,
      dayMinutes: day,
      cycle: { start: family.cycleStart, end: family.cycleEnd },
      ...(family.reason ? { note: family.reason } : {}),
    },
  ];
}

/**
 * Leave taken in a pay period and not yet paid, as payslip lines at the
 * employee's hourly rate. Returns the ledger ids so finalising can link them.
 */
export async function leavePayLines(tx: Tx, employeeId: string, periodStart: string, periodEnd: string, hourlyRateCents: number) {
  const rows = await tx
    .select()
    .from(leaveTransactions)
    .where(
      and(
        eq(leaveTransactions.employeeId, employeeId),
        eq(leaveTransactions.source, 'taken'),
        gte(leaveTransactions.occurredOn, periodStart),
        lte(leaveTransactions.occurredOn, periodEnd),
        isNull(leaveTransactions.payrollRunId),
      ),
    );
  const byType = new Map<LeaveType, number>();
  for (const r of rows) byType.set(r.leaveType as LeaveType, (byType.get(r.leaveType as LeaveType) ?? 0) - r.minutes);
  const lines: PayslipLine[] = [...byType.entries()].map(([type, minutes]) => ({
    code: `LEAVE_${type.toUpperCase()}`,
    kind: 'earning',
    description: LEAVE_LABEL[type],
    quantityMinutes: minutes,
    rateCents: hourlyRateCents,
    amountCents: Math.round((hourlyRateCents * minutes) / 60),
    sarsCode: '3601',
  }));
  return { lines, amountCents: lines.reduce((s, l) => s + l.amountCents, 0), transactionIds: rows.map((r) => r.id) };
}
