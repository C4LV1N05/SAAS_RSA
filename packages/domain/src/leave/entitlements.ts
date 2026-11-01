/**
 * BCEA leave entitlements, in minutes so they work for shift workers whose days
 * vary in length.
 *
 * - Annual leave (s20): accrues at one hour for every 17 hours worked (the
 *   s20(2)(c) basis, which suits hourly staff). Balance = accrued + adjustments
 *   - leave taken.
 * - Sick leave (s22): per 36-month cycle from the start of employment, as much
 *   time as the employee normally works in six weeks. In the first six months
 *   only one day for every 26 days worked.
 * - Family responsibility leave (s27): three days per year of employment, for
 *   employees employed longer than four months who work at least four days a week.
 *
 * Pure functions: callers supply worked minutes and taken minutes from the database.
 */
export type LeaveType = 'annual' | 'sick' | 'family_responsibility';

export interface LeaveProfile {
  employmentStart: string; // YYYY-MM-DD
  daysPerWeek: number;
  standardWeeklyMinutes: number;
}

/** A normal working day in minutes: the standard week spread over the days worked. */
export const dailyMinutes = (p: LeaveProfile) => Math.round(p.standardWeeklyMinutes / Math.max(1, p.daysPerWeek));

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Start of the cycle (of `months` length, counted from employment start) that contains `asOf`. */
export function cycleStart(employmentStart: string, asOf: string, months: number): string {
  let start = employmentStart;
  while (addMonths(start, months) <= asOf) start = addMonths(start, months);
  return start;
}

/** Annual leave accrued from worked minutes: 1 hour per 17 hours, rounded down to the minute. */
export const annualAccrualMinutes = (workedMinutes: number) => Math.floor(Math.max(0, workedMinutes) / 17);

export interface SickEntitlement {
  cycleStart: string;
  cycleEnd: string; // exclusive
  entitledMinutes: number;
  /** True while the employee is in the first six months (1 day per 26 days worked). */
  probationary: boolean;
}

/**
 * Sick leave for the cycle containing `asOf`. During the first six months of
 * employment, pass the days worked so far to get the 1-in-26 entitlement.
 */
export function sickEntitlement(p: LeaveProfile, asOf: string, daysWorkedInFirstSixMonths: number): SickEntitlement {
  const start = cycleStart(p.employmentStart, asOf, 36);
  const end = addMonths(start, 36);
  const probationary = asOf < addMonths(p.employmentStart, 6);
  const full = 6 * p.standardWeeklyMinutes;
  const entitledMinutes = probationary ? Math.min(full, Math.floor(daysWorkedInFirstSixMonths / 26) * dailyMinutes(p)) : full;
  return { cycleStart: start, cycleEnd: end, entitledMinutes, probationary };
}

export interface FamilyEntitlement {
  cycleStart: string;
  cycleEnd: string;
  entitledMinutes: number;
  /** Why there is no entitlement, when there is none. */
  reason?: string;
}

export function familyEntitlement(p: LeaveProfile, asOf: string): FamilyEntitlement {
  const start = cycleStart(p.employmentStart, asOf, 12);
  const end = addMonths(start, 12);
  if (p.daysPerWeek < 4) return { cycleStart: start, cycleEnd: end, entitledMinutes: 0, reason: 'Works fewer than four days a week' };
  if (asOf < addMonths(p.employmentStart, 4)) return { cycleStart: start, cycleEnd: end, entitledMinutes: 0, reason: 'Employed for less than four months' };
  return { cycleStart: start, cycleEnd: end, entitledMinutes: 3 * dailyMinutes(p) };
}

/**
 * BCEA s23: an employer may ask for a medical certificate when an employee is
 * off sick for more than two consecutive days, or more than twice in eight weeks.
 */
export function needsMedicalCertificate(days: number, sickAbsencesInLastEightWeeks: number): boolean {
  return days > 2 || sickAbsencesInLastEightWeeks >= 2;
}

/** Calendar days in an inclusive date range. */
export function daysInRange(startsOn: string, endsOn: string): number {
  return Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000) + 1;
}
