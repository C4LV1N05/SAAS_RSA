/**
 * BCEA compliance checks. They run twice:
 *  - on a draft schedule, before publishing (mode "schedule"), and
 *  - on approved time entries, before payroll (mode "actual").
 * A "block" finding stops the action unless a manager records an override reason.
 */
import type { RuleSet } from '../rules/registry';
import { DAY_MS, MINUTE_MS, localDate, localMidnight, minutesBetween } from '../time';
import type { Cents } from '../money';
import { segmentWork, totalSegments, workedPieces } from './segment';
import type { ComplianceFinding, EmployeeWorkProfile, PaySegment, WorkInterval } from './types';

const sortByStart = (xs: readonly WorkInterval[]) =>
  [...xs].sort((a, b) => a.start.getTime() - b.start.getTime());

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

/** BCEA s15(1)(a): 12 consecutive hours between finishing and starting work. */
export function checkDailyRest(intervals: readonly WorkInterval[], rules: RuleSet): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  const sorted = sortByStart(intervals);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    const required = rules.get('bcea.daily_rest_minutes', localDate(next.start));
    const gap = minutesBetween(prev.end, next.start);
    if (gap < required) {
      findings.push({
        ruleKey: 'bcea.daily_rest',
        severity: 'warn',
        subjectId: next.id,
        message: `Only ${hours(gap)} h rest before this shift; the BCEA requires ${hours(required)} h.`,
        data: { previousId: prev.id, restMinutes: gap, requiredMinutes: required },
      });
    }
  }
  return findings;
}

/** BCEA s15(1)(b): 36 consecutive hours of rest in each week (Monday-Sunday). */
export function checkWeeklyRest(
  intervals: readonly WorkInterval[],
  weekStartDate: string,
  rules: RuleSet,
): ComplianceFinding[] {
  const required = rules.get('bcea.weekly_rest_minutes', weekStartDate);
  const windowStart = localMidnight(weekStartDate);
  const windowEnd = new Date(windowStart.getTime() + 7 * DAY_MS);
  const inWeek = sortByStart(intervals)
    .filter((i) => i.end > windowStart && i.start < windowEnd)
    .map((i) => ({
      start: new Date(Math.max(i.start.getTime(), windowStart.getTime())),
      end: new Date(Math.min(i.end.getTime(), windowEnd.getTime())),
    }));
  if (inWeek.length === 0) return [];

  let longest = minutesBetween(windowStart, inWeek[0]!.start);
  for (let i = 1; i < inWeek.length; i++) {
    longest = Math.max(longest, minutesBetween(inWeek[i - 1]!.end, inWeek[i]!.start));
  }
  longest = Math.max(longest, minutesBetween(inWeek[inWeek.length - 1]!.end, windowEnd));

  if (longest >= required) return [];
  return [
    {
      ruleKey: 'bcea.weekly_rest',
      severity: 'warn',
      subjectId: weekStartDate,
      message: `Longest rest this week is ${hours(longest)} h; the BCEA requires ${hours(required)} consecutive hours.`,
      data: { longestRestMinutes: longest, requiredMinutes: required },
    },
  ];
}

/** BCEA s14: a meal interval after 5 hours of continuous work. */
export function checkMealIntervals(
  intervals: readonly WorkInterval[],
  profile: EmployeeWorkProfile,
  rules: RuleSet,
): ComplianceFinding[] {
  const findings: ComplianceFinding[] = [];
  for (const interval of sortByStart(intervals)) {
    const maxContinuous = rules.get('bcea.meal_interval_after_minutes', localDate(interval.start));
    // Any break at least as long as the employee's meal interval resets the clock.
    const qualifying = (interval.breaks ?? [])
      .filter((b) => minutesBetween(b.start, b.end) >= profile.mealIntervalMinutes)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    let cursor = interval.start;
    let longest = 0;
    for (const b of qualifying) {
      longest = Math.max(longest, minutesBetween(cursor, b.start));
      cursor = b.end;
    }
    longest = Math.max(longest, minutesBetween(cursor, interval.end));
    if (longest > maxContinuous) {
      findings.push({
        ruleKey: 'bcea.meal_interval',
        severity: 'warn',
        subjectId: interval.id,
        message: `${hours(longest)} h of continuous work without a ${profile.mealIntervalMinutes}-minute meal interval (limit ${hours(maxContinuous)} h).`,
        data: { continuousMinutes: longest, mealIntervalMinutes: profile.mealIntervalMinutes },
      });
    }
  }
  return findings;
}

/** BCEA s10: overtime only by agreement, max 3 h a day and 10 h a week. */
export function checkOvertime(
  segments: readonly PaySegment[],
  profile: EmployeeWorkProfile,
  rules: RuleSet,
): ComplianceFinding[] {
  if (profile.bceaThresholdExempt) return [];
  const findings: ComplianceFinding[] = [];
  const byDay = new Map<string, { minutes: number; intervalId: string }>();
  let weekMinutes = 0;
  let firstDay: string | undefined;
  for (const s of segments) {
    if (!s.isOvertime) continue;
    firstDay ??= s.workday;
    weekMinutes += s.minutes;
    const day = byDay.get(s.workday) ?? { minutes: 0, intervalId: s.intervalId };
    day.minutes += s.minutes;
    byDay.set(s.workday, day);
  }
  if (weekMinutes === 0) return [];

  if (!profile.overtimeAgreement) {
    findings.push({
      ruleKey: 'bcea.overtime_agreement',
      severity: 'block',
      subjectId: firstDay!,
      message: `${hours(weekMinutes)} h of overtime without an overtime agreement on file.`,
      data: { overtimeMinutes: weekMinutes },
    });
  }
  for (const [day, { minutes, intervalId }] of byDay) {
    const limit = rules.get('bcea.max_overtime_daily_minutes', day);
    if (minutes > limit) {
      findings.push({
        ruleKey: 'bcea.overtime_daily_limit',
        severity: 'block',
        subjectId: intervalId,
        message: `${hours(minutes)} h overtime on ${day}; the daily limit is ${hours(limit)} h.`,
        data: { day, overtimeMinutes: minutes, limitMinutes: limit },
      });
    }
  }
  const weeklyLimit = rules.get('bcea.max_overtime_weekly_minutes', firstDay!);
  if (weekMinutes > weeklyLimit) {
    findings.push({
      ruleKey: 'bcea.overtime_weekly_limit',
      severity: 'block',
      subjectId: firstDay!,
      message: `${hours(weekMinutes)} h overtime this week; the weekly limit is ${hours(weeklyLimit)} h.`,
      data: { overtimeMinutes: weekMinutes, limitMinutes: weeklyLimit },
    });
  }
  return findings;
}

/**
 * National Minimum Wage: wages for hours worked, EXCLUDING tips and gratuities
 * (Sectoral Determination 14), must average at least the NMW per hour.
 */
export function checkMinimumWage(input: {
  subjectId: string;
  wageCents: Cents;
  workedMinutes: number;
  onDate: string;
  rules: RuleSet;
}): ComplianceFinding[] {
  if (input.workedMinutes <= 0) return [];
  const nmw = input.rules.get('nmw.hourly_cents', input.onDate);
  const effectiveHourly = (input.wageCents * 60) / input.workedMinutes;
  if (effectiveHourly + 1e-9 >= nmw) return [];
  return [
    {
      ruleKey: 'nmw.hourly_floor',
      severity: 'block',
      subjectId: input.subjectId,
      message: `Effective rate R${(effectiveHourly / 100).toFixed(2)}/h is below the National Minimum Wage of R${(nmw / 100).toFixed(2)}/h (tips excluded).`,
      data: { effectiveHourlyCents: Math.floor(effectiveHourly), nmwHourlyCents: nmw },
    },
  ];
}

export interface WeekCheckInput {
  intervals: readonly WorkInterval[];
  profile: EmployeeWorkProfile;
  weekStartDate: string;
  rules: RuleSet;
  publicHolidays: ReadonlySet<string>;
  /** Intervals from the previous week's end, to test rest across the week boundary. */
  priorIntervals?: readonly WorkInterval[];
  /** Hourly rate, for the NMW test. */
  hourlyRateCents?: Cents;
}

export interface WeekCheckResult {
  segments: PaySegment[];
  totals: ReturnType<typeof totalSegments>;
  findings: ComplianceFinding[];
  blocked: boolean;
}

/** Run every BCEA check for one employee-week. */
export function checkEmployeeWeek(input: WeekCheckInput): WeekCheckResult {
  const { intervals, profile, rules, publicHolidays, weekStartDate } = input;
  const segments = segmentWork(intervals, profile, { rules, publicHolidays });
  const totals = totalSegments(segments);
  const findings: ComplianceFinding[] = [
    ...checkDailyRest([...(input.priorIntervals ?? []), ...intervals], rules).filter((f) =>
      intervals.some((i) => i.id === f.subjectId),
    ),
    ...checkWeeklyRest(intervals, weekStartDate, rules),
    ...checkMealIntervals(intervals, profile, rules),
    ...checkOvertime(segments, profile, rules),
  ];
  if (input.hourlyRateCents !== undefined) {
    findings.push(
      ...checkMinimumWage({
        subjectId: weekStartDate,
        wageCents: input.hourlyRateCents * (totals.workedMinutes / 60),
        workedMinutes: totals.workedMinutes,
        onDate: weekStartDate,
        rules,
      }),
    );
  }
  return { segments, totals, findings, blocked: findings.some((f) => f.severity === 'block') };
}

/** Worked minutes of an interval after unpaid breaks. */
export function workedMinutes(interval: WorkInterval): number {
  return workedPieces(interval).reduce((m, p) => m + (p.end.getTime() - p.start.getTime()) / MINUTE_MS, 0);
}
