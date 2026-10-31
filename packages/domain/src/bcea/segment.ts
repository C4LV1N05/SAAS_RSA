/**
 * Pay segmentation: splits approved work into ordinary, overtime, Sunday and
 * public holiday minutes, the way the BCEA prices them.
 *
 * Assumptions (to be signed off by a labour lawyer, see docs/ARCHITECTURE.md):
 *  - The daily ordinary limit applies to the local date the shift STARTED on, so a
 *    shift crossing midnight is one "day" for hours, but its minutes after midnight
 *    are priced on the new date (e.g. Saturday 18:00 - Sunday 02:00 has Sunday pay).
 *  - Sunday and public holiday minutes count toward the daily and weekly ordinary
 *    limits. Overtime on a Sunday or public holiday is paid at the higher multiplier.
 *  - Weeks run Monday to Sunday, local time.
 *  - Employees above the BCEA earnings threshold get no overtime or Sunday premium
 *    (s6(3)); public holiday double pay is kept for them.
 */
import type { RuleSet } from '../rules/registry';
import {
  localDate,
  localMinuteOfDay,
  dayOfWeek,
  nextLocalMidnight,
  minutesBetween,
  weekStart,
  MINUTE_MS,
} from '../time';
import type { EmployeeWorkProfile, PaySegment, WorkInterval } from './types';

interface Piece {
  intervalId: string;
  start: Date;
  end: Date;
  workday: string;
}

/** Interval minus unpaid breaks. Paid breaks are paid working time. */
export function workedPieces(interval: WorkInterval): Array<{ start: Date; end: Date }> {
  const unpaid = (interval.breaks ?? [])
    .filter((b) => !b.paid)
    .map((b) => ({
      start: new Date(Math.max(b.start.getTime(), interval.start.getTime())),
      end: new Date(Math.min(b.end.getTime(), interval.end.getTime())),
    }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const pieces: Array<{ start: Date; end: Date }> = [];
  let cursor = interval.start;
  for (const b of unpaid) {
    if (b.start > cursor) pieces.push({ start: cursor, end: b.start });
    if (b.end > cursor) cursor = b.end;
  }
  if (interval.end > cursor) pieces.push({ start: cursor, end: interval.end });
  return pieces;
}

/** Split a piece at every local midnight it crosses. */
function splitAtMidnight(piece: Piece): Piece[] {
  const out: Piece[] = [];
  let start = piece.start;
  while (start < piece.end) {
    const midnight = nextLocalMidnight(start);
    const end = midnight < piece.end ? midnight : piece.end;
    out.push({ ...piece, start, end });
    start = end;
  }
  return out;
}

function nightMinutes(start: Date, end: Date, nightStart: number, nightEnd: number): number {
  // start and end are on the same local date (already split at midnight)
  const from = localMinuteOfDay(start);
  const to = from + minutesBetween(start, end);
  const overlap = (a: number, b: number) => Math.max(0, Math.min(to, b) - Math.max(from, a));
  return overlap(0, nightEnd) + overlap(nightStart, 1440);
}

export interface SegmentOptions {
  rules: RuleSet;
  publicHolidays: ReadonlySet<string>;
}

export function segmentWork(
  intervals: readonly WorkInterval[],
  profile: EmployeeWorkProfile,
  { rules, publicHolidays }: SegmentOptions,
): PaySegment[] {
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const chunks: Piece[] = [];
  for (const interval of sorted) {
    const workday = localDate(interval.start);
    for (const p of workedPieces(interval)) {
      chunks.push(...splitAtMidnight({ intervalId: interval.id, start: p.start, end: p.end, workday }));
    }
  }

  const dailyOrdinary = new Map<string, number>();
  const weeklyOrdinary = new Map<string, number>();
  const segments: PaySegment[] = [];

  for (const chunk of chunks) {
    const onDate = chunk.workday;
    const dailyLimit = rules.get(
      profile.daysPerWeek <= 5 ? 'bcea.max_ordinary_daily_minutes_5day' : 'bcea.max_ordinary_daily_minutes_6day',
      onDate,
    );
    const weeklyLimit = rules.get('bcea.max_ordinary_weekly_minutes', onDate);
    const otMultiplier = rules.get('bcea.overtime_multiplier', onDate);
    const sundayMultiplier = profile.ordinarilyWorksSundays
      ? rules.get('bcea.sunday_multiplier_ordinarily_worked', onDate)
      : rules.get('bcea.sunday_multiplier_not_ordinarily_worked', onDate);
    const phMultiplier = rules.get('bcea.public_holiday_multiplier', onDate);
    const nightStart = rules.get('bcea.night_start_minute', onDate);
    const nightEnd = rules.get('bcea.night_end_minute', onDate);

    const week = weekStart(chunk.workday);
    const minutes = minutesBetween(chunk.start, chunk.end);
    const usedDay = dailyOrdinary.get(chunk.workday) ?? 0;
    const usedWeek = weeklyOrdinary.get(week) ?? 0;

    const capacity = profile.bceaThresholdExempt
      ? minutes
      : Math.max(0, Math.min(dailyLimit - usedDay, weeklyLimit - usedWeek));
    const ordinaryMinutes = Math.min(minutes, capacity);
    dailyOrdinary.set(chunk.workday, usedDay + ordinaryMinutes);
    weeklyOrdinary.set(week, usedWeek + ordinaryMinutes);

    const date = localDate(chunk.start);
    const isHoliday = publicHolidays.has(date);
    const isSunday = dayOfWeek(date) === 0;

    const parts: Array<{ start: Date; end: Date; overtime: boolean }> = [];
    const split = new Date(chunk.start.getTime() + ordinaryMinutes * MINUTE_MS);
    if (ordinaryMinutes > 0) parts.push({ start: chunk.start, end: split, overtime: false });
    if (ordinaryMinutes < minutes) parts.push({ start: split, end: chunk.end, overtime: true });

    for (const part of parts) {
      let payType: PaySegment['payType'];
      let multiplier: number;
      if (isHoliday) {
        payType = 'public_holiday';
        multiplier = phMultiplier;
      } else if (isSunday && !profile.bceaThresholdExempt) {
        payType = 'sunday';
        multiplier = part.overtime ? Math.max(sundayMultiplier, otMultiplier) : sundayMultiplier;
      } else if (part.overtime) {
        payType = 'overtime';
        multiplier = otMultiplier;
      } else {
        payType = 'ordinary';
        multiplier = 1;
      }
      segments.push({
        intervalId: chunk.intervalId,
        start: part.start,
        end: part.end,
        minutes: minutesBetween(part.start, part.end),
        localDate: date,
        workday: chunk.workday,
        payType,
        isOvertime: part.overtime,
        multiplier,
        nightMinutes: nightMinutes(part.start, part.end, nightStart, nightEnd),
      });
    }
  }
  return segments;
}

export interface SegmentTotals {
  workedMinutes: number;
  ordinaryMinutes: number;
  overtimeMinutes: number;
  sundayMinutes: number;
  publicHolidayMinutes: number;
  nightMinutes: number;
}

export function totalSegments(segments: readonly PaySegment[]): SegmentTotals {
  const t: SegmentTotals = {
    workedMinutes: 0,
    ordinaryMinutes: 0,
    overtimeMinutes: 0,
    sundayMinutes: 0,
    publicHolidayMinutes: 0,
    nightMinutes: 0,
  };
  for (const s of segments) {
    t.workedMinutes += s.minutes;
    if (s.isOvertime) t.overtimeMinutes += s.minutes;
    else t.ordinaryMinutes += s.minutes;
    if (s.payType === 'sunday') t.sundayMinutes += s.minutes;
    if (s.payType === 'public_holiday') t.publicHolidayMinutes += s.minutes;
    t.nightMinutes += s.nightMinutes;
  }
  return t;
}
