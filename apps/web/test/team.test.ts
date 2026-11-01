import { describe, expect, it } from 'vitest';
import { addDays, dayLabel, hm, sastDate, sastInstant, timeOf, weekStart } from '../src/lib/dates';
import { effectiveState, toRequest, type ClockAction } from '../src/lib/clockQueue';
import { canSee, homeScreen } from '../src/staff/access';
import { groupWarnings, labourCents, shiftMinutes, type Shift } from '../src/staff/Schedule';
import { flags, type Entry } from '../src/staff/Timesheets';
import { blocker, lastPeriod } from '../src/staff/Payroll';
import { currentShift } from '../src/staff/Me';
import type { Team, TeamMember } from '../src/staff/team';

describe('SAST dates', () => {
  it('uses the South African calendar day, not UTC', () => {
    expect(sastDate(new Date('2026-11-01T22:30:00Z'))).toBe('2026-11-02'); // 00:30 SAST
  });
  it('starts weeks on Monday, as the BCEA does', () => {
    expect(weekStart('2026-11-01')).toBe('2026-10-26'); // a Sunday
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('rolls an end time before the start into the next morning', () => {
    const start = sastInstant('2026-11-06', '18:00');
    expect(sastInstant('2026-11-06', '02:00', start)).toBe('2026-11-07T02:00:00+02:00');
    expect(timeOf('2026-11-06T16:00:00Z')).toBe('18:00');
  });
  it('formats labels and durations', () => {
    expect(dayLabel('2026-11-09')).toBe('Mon 9 Nov');
    expect(hm(450)).toBe('7 h 30');
    expect(hm(480)).toBe('8 h');
    expect(hm(25)).toBe('25 min');
  });
});

const member = (over: Partial<TeamMember>): TeamMember => ({
  id: 'e1', firstName: 'A', lastName: 'B', jobRoleId: null, jobRole: null, tipGroup: 'foh',
  hasLogin: true, hasDateOfBirth: true, daysPerWeek: 5, overtimeAgreement: false, rate: { type: 'hourly', cents: 3_000 }, ...over,
});

describe('schedule', () => {
  const shift = (employeeId: string | null, start: string, end: string, brk = 60): Shift => ({
    id: start, employeeId, locationId: 'l', startsAt: start, endsAt: end, plannedBreakMinutes: brk, status: 'draft',
  });
  it('costs shifts at hourly rates, net of unpaid breaks', () => {
    const team: Team = { employees: [member({ id: 'e1' }), member({ id: 'e2', rate: { type: 'monthly', cents: 900_000 } })], jobRoles: [] };
    const s1 = shift('e1', '2026-11-09T09:00:00+02:00', '2026-11-09T17:00:00+02:00');
    expect(shiftMinutes(s1)).toBe(420);
    expect(labourCents([s1, shift('e2', '2026-11-09T09:00:00+02:00', '2026-11-09T17:00:00+02:00'), shift(null, '2026-11-09T09:00:00+02:00', '2026-11-09T12:00:00+02:00', 0)], team)).toBe(21_000);
  });
  it('shows a repeated warning once, with how many shifts it affects', () => {
    const f = (subjectId: string) => ({ ruleKey: 'bcea.meal_interval', severity: 'warn' as const, subjectId, message: '6 h without a meal interval', employeeId: 'e1', week: '2026-11-09' });
    expect(groupWarnings([f('a'), f('b'), f('c')])).toEqual([{ employeeId: 'e1', message: '6 h without a meal interval', times: 3 }]);
  });
});

describe('timesheet flags', () => {
  const entry = (over: Partial<Entry>): Entry => ({
    id: 't', employeeId: 'e', clockIn: '2026-11-02T09:00:00+02:00', clockOut: '2026-11-02T17:00:00+02:00', status: 'submitted', method: 'mobile',
    capturedOffline: false, editReason: null, workedMinutes: 420, breaks: [], shift: { startsAt: '2026-11-02T09:00:00+02:00', endsAt: '2026-11-02T17:00:00+02:00' }, ...over,
  });
  it('is quiet when the entry matches the shift', () => {
    expect(flags(entry({}))).toEqual([]);
  });
  it('points out late starts, long overruns, offline clocks and edits', () => {
    expect(flags(entry({ clockIn: '2026-11-02T09:18:00+02:00', clockOut: '2026-11-02T17:40:00+02:00', capturedOffline: true, editReason: 'Phone died' }))).toEqual([
      '18 min late', '40 min past shift end', 'Clocked offline', 'Edited: Phone died',
    ]);
    expect(flags(entry({ shift: null }))).toEqual(['No shift planned']);
  });
});

describe('payroll screen', () => {
  it('picks the last complete period', () => {
    expect(lastPeriod('weekly', '2026-11-04')).toEqual({ start: '2026-10-26', end: '2026-11-01', payDate: '2026-11-06' });
    expect(lastPeriod('fortnightly', '2026-11-04').start).toBe('2026-10-19');
    expect(lastPeriod('monthly', '2026-01-15')).toEqual({ start: '2025-12-01', end: '2025-12-31', payDate: '2026-01-01' });
  });
  it('explains who cannot be paid yet', () => {
    expect(blocker(member({}))).toBeNull();
    expect(blocker(member({ rate: null }))).toBe('No pay rate set');
    expect(blocker(member({ hasDateOfBirth: false }))).toMatch(/Date of birth/);
  });
});

describe('clocking without signal', () => {
  const inAction: ClockAction = { kind: 'in', key: 'k1', at: '2026-11-02T08:00:00.000Z', body: { employeeId: 'e', locationId: 'l', method: 'mobile' } };
  const outAction: ClockAction = { kind: 'out', key: 'k2', at: '2026-11-02T16:00:00.000Z' };
  it('sends the time it really happened, with the same idempotency key', () => {
    expect(toRequest(inAction, null)).toEqual({
      path: '/v1/time/clock-in', key: 'k1', body: { employeeId: 'e', locationId: 'l', method: 'mobile', deviceTime: '2026-11-02T08:00:00.000Z', offline: true },
    });
  });
  it('links a clock-out to a clock-in that synced in the same batch', () => {
    expect(toRequest(outAction, 'entry-1')).toEqual({ path: '/v1/time/clock-out', body: { timeEntryId: 'entry-1', deviceTime: '2026-11-02T16:00:00.000Z', offline: true } });
    expect(toRequest(outAction, null)).toBeNull();
  });
  it('shows the state including actions still on the phone', () => {
    expect(effectiveState(false, [inAction])).toBe('in');
    expect(effectiveState(true, [outAction])).toBe('out');
    expect(effectiveState(true, [])).toBe('in');
  });
  it('clocks in against the shift under way or starting soon', () => {
    const now = Date.parse('2026-11-02T08:30:00Z');
    const shifts = [
      { id: 'late', locationId: 'l', startsAt: '2026-11-02T14:00:00Z', endsAt: '2026-11-02T20:00:00Z', plannedBreakMinutes: 0 },
      { id: 'soon', locationId: 'l', startsAt: '2026-11-02T10:00:00Z', endsAt: '2026-11-02T16:00:00Z', plannedBreakMinutes: 0 },
    ];
    expect(currentShift(shifts, now)?.id).toBe('soon');
    expect(currentShift(shifts, Date.parse('2026-11-02T05:00:00Z'))).toBeUndefined();
  });
});

describe('screen access by role', () => {
  it('matches the API permissions', () => {
    expect(canSee('payroll_admin', 'payroll')).toBe(true);
    expect(canSee('general_manager', 'payroll')).toBe(false);
    expect(canSee('employee', 'schedule')).toBe(false);
    expect(canSee('employee', 'me')).toBe(true);
    expect(canSee('shift_manager', 'menu')).toBe(false);
    expect(homeScreen('employee')).toBe('me');
    expect(homeScreen('payroll_admin')).toBe('timesheets');
  });
});
