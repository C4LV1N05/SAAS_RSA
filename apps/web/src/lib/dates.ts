/**
 * Dates for the staff screens, always in South African time. South Africa has no
 * daylight saving, so SAST is a fixed UTC+02:00 and "YYYY-MM-DD" + "HH:MM" can
 * be turned into an instant without a time-zone library.
 */
const TZ = 'Africa/Johannesburg';
const OFFSET = '+02:00';
const DAY_MS = 86_400_000;

/** Calendar date in SAST, as YYYY-MM-DD. */
export function sastDate(d: Date = new Date()): string {
  return new Date(d.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the week containing the date (BCEA weeks run Monday to Sunday). */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The instant for a SAST date and HH:MM time. Times before `after` roll to the next day (night shifts). */
export function sastInstant(date: string, time: string, after?: string): string {
  const iso = `${date}T${time}:00${OFFSET}`;
  if (after && Date.parse(iso) <= Date.parse(after)) return `${addDays(date, 1)}T${time}:00${OFFSET}`;
  return iso;
}

export function timeOf(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** "Mon 2 Nov" (en-GB gives day-month order without zero padding or commas) */
export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T00:00:00Z`));
}

/** "Monday 2 November" */
export function longDayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T00:00:00Z`));
}

/** "2 Nov, 14:05" in SAST */
export function stamp(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** 450 -> "7 h 30", 480 -> "8 h" */
export function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${String(r).padStart(2, '0')}`;
}

export function minutesBetween(a: string | Date, b: string | Date): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

/** 1080 minutes of 540-minute days -> "2 days"; 270 -> "half a day" */
export function daysText(minutes: number, dayMinutes: number): string {
  const d = Math.round((minutes / Math.max(1, dayMinutes)) * 2) / 2;
  if (d === 0.5) return 'half a day';
  if (d === 1) return '1 day';
  return `${d % 1 === 0 ? d : d.toFixed(1)} days`;
}
