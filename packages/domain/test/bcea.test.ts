import { describe, expect, it } from 'vitest';
import {
  checkDailyRest,
  checkEmployeeWeek,
  checkMealIntervals,
  checkMinimumWage,
  checkOvertime,
  checkWeeklyRest,
  segmentWork,
  totalSegments,
} from '../src';
import { holidays, profile, rules, sast, shift } from './helpers';

// Monday 2 November 2026 starts the test week.
const weekdays = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
const seg = (intervals: Parameters<typeof segmentWork>[0], p = profile()) =>
  segmentWork(intervals, p, { rules: rules(), publicHolidays: holidays });

describe('pay segmentation', () => {
  it('treats a 45-hour, 5-day week as ordinary time', () => {
    const totals = totalSegments(seg(weekdays.map((d, i) => shift(`s${i}`, d, '08:00', '17:00'))));
    expect(totals).toMatchObject({ workedMinutes: 2700, ordinaryMinutes: 2700, overtimeMinutes: 0 });
  });

  it('makes the 10th hour of a day overtime (5-day week: 9 h daily limit)', () => {
    const totals = totalSegments(seg([shift('a', '2026-11-02', '08:00', '18:00')]));
    expect(totals.ordinaryMinutes).toBe(540);
    expect(totals.overtimeMinutes).toBe(60);
  });

  it('uses an 8 h daily limit for a 6-day week', () => {
    const totals = totalSegments(seg([shift('a', '2026-11-02', '08:00', '17:00')], profile({ daysPerWeek: 6 })));
    expect(totals.overtimeMinutes).toBe(60);
  });

  it('makes hours beyond 45 a week overtime even when no single day is long', () => {
    const week = [...weekdays.map((d, i) => shift(`s${i}`, d, '08:00', '17:00')), shift('sat', '2026-11-07', '10:00', '14:00')];
    const segments = seg(week);
    expect(totalSegments(segments).overtimeMinutes).toBe(240);
    expect(segments.filter((s) => s.intervalId === 'sat').every((s) => s.payType === 'overtime')).toBe(true);
  });

  it('deducts unpaid breaks but keeps paid ones', () => {
    const base = shift('a', '2026-11-02', '08:00', '17:00');
    const unpaid = { ...base, breaks: [{ start: sast('2026-11-02T12:00'), end: sast('2026-11-02T13:00'), paid: false }] };
    const paid = { ...base, breaks: [{ start: sast('2026-11-02T12:00'), end: sast('2026-11-02T12:30'), paid: true }] };
    expect(totalSegments(seg([unpaid])).workedMinutes).toBe(480);
    expect(totalSegments(seg([paid])).workedMinutes).toBe(540);
  });

  it('splits a Saturday night shift at midnight: Sunday minutes get Sunday pay', () => {
    const segments = seg([shift('night', '2026-11-07', '18:00', '02:00', '2026-11-08')]);
    const saturday = segments.filter((s) => s.localDate === '2026-11-07');
    const sunday = segments.filter((s) => s.localDate === '2026-11-08');
    expect(saturday.reduce((m, s) => m + s.minutes, 0)).toBe(360);
    expect(sunday).toHaveLength(1);
    expect(sunday[0]).toMatchObject({ payType: 'sunday', minutes: 120, multiplier: 2, workday: '2026-11-07' });
    expect(totalSegments(segments).nightMinutes).toBe(480);
  });

  it('pays Sunday at 1.5x for staff who ordinarily work Sundays', () => {
    const [s] = seg([shift('sun', '2026-11-08', '10:00', '14:00')], profile({ ordinarilyWorksSundays: true }));
    expect(s).toMatchObject({ payType: 'sunday', multiplier: 1.5 });
  });

  it('pays public holiday work at double time', () => {
    const [s] = seg([shift('ph', '2026-12-16', '10:00', '16:00')]);
    expect(s).toMatchObject({ payType: 'public_holiday', multiplier: 2, minutes: 360 });
  });

  it('gives exempt (above-threshold) staff no overtime', () => {
    const totals = totalSegments(seg([shift('a', '2026-11-02', '07:00', '19:00')], profile({ bceaThresholdExempt: true })));
    expect(totals.overtimeMinutes).toBe(0);
    expect(totals.ordinaryMinutes).toBe(720);
  });
});

describe('BCEA checks', () => {
  it('flags less than 12 hours rest between shifts', () => {
    const findings = checkDailyRest(
      [shift('close', '2026-11-02', '15:00', '23:00'), shift('open', '2026-11-03', '07:00', '15:00')],
      rules(),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleKey: 'bcea.daily_rest', subjectId: 'open', data: { restMinutes: 480 } });
  });

  it('flags a week without 36 consecutive hours of rest', () => {
    const sevenDays = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
    const findings = checkWeeklyRest(sevenDays.map((d, i) => shift(`d${i}`, d, '10:00', '18:00')), '2026-11-02', rules());
    expect(findings[0]?.ruleKey).toBe('bcea.weekly_rest');
    expect(checkWeeklyRest(weekdays.map((d, i) => shift(`d${i}`, d, '08:00', '17:00')), '2026-11-02', rules())).toEqual([]);
  });

  it('requires a meal interval after 5 hours of continuous work', () => {
    const long = shift('a', '2026-11-02', '08:00', '15:00');
    expect(checkMealIntervals([long], profile(), rules())).toHaveLength(1);
    const withMeal = { ...long, breaks: [{ start: sast('2026-11-02T12:00'), end: sast('2026-11-02T13:00'), paid: false }] };
    expect(checkMealIntervals([withMeal], profile(), rules())).toEqual([]);
    const shortBreak = { ...long, breaks: [{ start: sast('2026-11-02T12:00'), end: sast('2026-11-02T12:30'), paid: false }] };
    expect(checkMealIntervals([shortBreak], profile(), rules())).toHaveLength(1);
    expect(checkMealIntervals([shortBreak], profile({ mealIntervalMinutes: 30 }), rules())).toEqual([]);
  });

  it('blocks overtime without an agreement and above 3 h a day', () => {
    const segments = seg([shift('a', '2026-11-02', '06:00', '19:00')]);
    const keys = checkOvertime(segments, profile({ overtimeAgreement: false }), rules()).map((f) => f.ruleKey);
    expect(keys).toEqual(['bcea.overtime_agreement', 'bcea.overtime_daily_limit']);
  });

  it('blocks more than 10 h overtime a week', () => {
    const segments = seg(weekdays.map((d, i) => shift(`s${i}`, d, '07:00', '18:30')));
    expect(totalSegments(segments).overtimeMinutes).toBe(750);
    const keys = checkOvertime(segments, profile(), rules()).map((f) => f.ruleKey);
    expect(keys).toContain('bcea.overtime_weekly_limit');
  });

  it('enforces the National Minimum Wage on wages only', () => {
    const base = { subjectId: 'e1', workedMinutes: 600, onDate: '2026-11-01', rules: rules() };
    expect(checkMinimumWage({ ...base, wageCents: 29_000 })[0]?.severity).toBe('block'); // R29/h
    expect(checkMinimumWage({ ...base, wageCents: 30_230 })).toEqual([]); // R30.23/h
  });

  it('runs every check for an employee-week', () => {
    const result = checkEmployeeWeek({
      intervals: weekdays.map((d, i) => shift(`s${i}`, d, '08:00', '17:00')),
      profile: profile(),
      weekStartDate: '2026-11-02',
      rules: rules(),
      publicHolidays: holidays,
      hourlyRateCents: 3500,
    });
    expect(result.blocked).toBe(false);
    // 9-hour shifts with no break trip the meal-interval warning on every day.
    expect(result.findings.every((f) => f.ruleKey === 'bcea.meal_interval')).toBe(true);
    expect(result.totals.ordinaryMinutes).toBe(2700);
  });
});
