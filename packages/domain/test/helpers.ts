import { RuleSet, SA_PUBLIC_HOLIDAYS, SA_RULE_VERSIONS, type EmployeeWorkProfile } from '../src';

/** A local SAST time, e.g. sast('2026-11-02T08:00'). */
export const sast = (local: string): Date => new Date(`${local}:00+02:00`);

export const rules = () => new RuleSet(SA_RULE_VERSIONS);
export const holidays = new Set(SA_PUBLIC_HOLIDAYS.map((h) => h.date));

export const profile = (overrides: Partial<EmployeeWorkProfile> = {}): EmployeeWorkProfile => ({
  daysPerWeek: 5,
  ordinarilyWorksSundays: false,
  overtimeAgreement: true,
  mealIntervalMinutes: 60,
  bceaThresholdExempt: false,
  ...overrides,
});

/** A shift on a local date between two local times (end may be the next day). */
export const shift = (id: string, date: string, from: string, to: string, endDate = date) => ({
  id,
  start: sast(`${date}T${from}`),
  end: sast(`${endDate}T${to}`),
});
