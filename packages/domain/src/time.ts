/**
 * Time helpers. Instants are stored in UTC; South Africa Standard Time is a fixed
 * UTC+02:00 with no daylight saving, so local calendar maths is a fixed offset.
 */
export const SAST_OFFSET_MINUTES = 120;
const OFFSET_MS = SAST_OFFSET_MINUTES * 60_000;
export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** Local SAST calendar date of an instant, as YYYY-MM-DD. */
export function localDate(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes past local midnight (0..1439). */
export function localMinuteOfDay(instant: Date): number {
  const shifted = new Date(instant.getTime() + OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** 0 = Sunday .. 6 = Saturday, for a YYYY-MM-DD date. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The instant of local midnight at the start of a YYYY-MM-DD date. */
export function localMidnight(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - OFFSET_MS);
}

/** The next local midnight strictly after an instant. */
export function nextLocalMidnight(instant: Date): Date {
  const start = localMidnight(localDate(instant));
  return new Date(start.getTime() + DAY_MS);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the local week containing the date (BCEA weeks run Monday to Sunday here). */
export function weekStart(date: string): string {
  const dow = dayOfWeek(date);
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / MINUTE_MS);
}

/** Whole years between a date of birth and a reference date. */
export function ageOn(dateOfBirth: string, onDate: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [y, m, d] = onDate.split('-').map(Number) as [number, number, number];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

/** Last day of the SA tax year (28/29 February) that contains the date. */
export function taxYearEnd(onDate: string): string {
  const [y, m] = onDate.split('-').map(Number) as [number, number];
  const endYear = m >= 3 ? y + 1 : y;
  const leap = (endYear % 4 === 0 && endYear % 100 !== 0) || endYear % 400 === 0;
  return `${endYear}-02-${leap ? '29' : '28'}`;
}
