import { describe, expect, it } from 'vitest';
import {
  addMonths,
  annualAccrualMinutes,
  cycleStart,
  dailyMinutes,
  daysInRange,
  familyEntitlement,
  needsMedicalCertificate,
  sickEntitlement,
} from '../src/leave/entitlements';

const fullTime = { employmentStart: '2025-03-10', daysPerWeek: 5, standardWeeklyMinutes: 2700 };

describe('BCEA leave', () => {
  it('accrues annual leave at 1 hour per 17 hours worked', () => {
    expect(annualAccrualMinutes(17 * 60)).toBe(60);
    // A full year of 45-hour weeks earns about 15 working days (s20: 21 consecutive days).
    expect(annualAccrualMinutes(52 * 2700) / dailyMinutes(fullTime)).toBeCloseTo(15.3, 1);
  });

  it('adds months safely at month ends', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(cycleStart('2023-05-01', '2026-11-02', 36)).toBe('2026-05-01');
  });

  it('gives six weeks of sick leave per 36-month cycle, but 1 day per 26 worked in the first six months', () => {
    expect(sickEntitlement(fullTime, '2026-11-02', 0)).toEqual({ cycleStart: '2025-03-10', cycleEnd: '2028-03-10', entitledMinutes: 16_200, probationary: false });
    const newcomer = { ...fullTime, employmentStart: '2026-08-03' };
    expect(sickEntitlement(newcomer, '2026-11-02', 60)).toMatchObject({ probationary: true, entitledMinutes: 2 * 540 });
  });

  it('gives three family responsibility days after four months, to people working four or more days a week', () => {
    expect(familyEntitlement(fullTime, '2026-11-02')).toMatchObject({ entitledMinutes: 1620, cycleStart: '2026-03-10' });
    expect(familyEntitlement({ ...fullTime, daysPerWeek: 3 }, '2026-11-02')).toMatchObject({ entitledMinutes: 0, reason: expect.stringMatching(/four days/) });
    expect(familyEntitlement({ ...fullTime, employmentStart: '2026-09-01' }, '2026-11-02')).toMatchObject({ entitledMinutes: 0, reason: expect.stringMatching(/four months/) });
  });

  it('asks for a medical certificate after two days off, or a third absence in eight weeks', () => {
    expect(needsMedicalCertificate(2, 0)).toBe(false);
    expect(needsMedicalCertificate(3, 0)).toBe(true);
    expect(needsMedicalCertificate(1, 2)).toBe(true);
    expect(daysInRange('2026-11-02', '2026-11-04')).toBe(3);
  });
});
