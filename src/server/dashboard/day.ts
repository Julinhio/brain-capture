import type { DayWindow } from '../../shared/dashboard.js';

export function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Search for the first instant whose local date matches the requested date. This also
// handles 23/25-hour DST days and zones whose midnight itself is skipped.
function dateStart(date: string, timeZone: string): Date {
  let lo = Date.parse(`${date}T00:00:00Z`) - 36 * 3600_000;
  let hi = lo + 72 * 3600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(new Date(mid), timeZone) < date) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

export function dayWindow(timeZone: string, now = new Date()): DayWindow {
  // Intl throws on invalid zones; the route turns this into a 400.
  const date = localDate(now, timeZone);
  const anchor = new Date(`${date}T12:00:00Z`);
  const previousDate = new Date(anchor.getTime() - 86400_000).toISOString().slice(0, 10);
  const nextDate = new Date(anchor.getTime() + 86400_000).toISOString().slice(0, 10);
  return {
    date,
    previousDate,
    start: dateStart(date, timeZone).toISOString(),
    end: dateStart(nextDate, timeZone).toISOString(),
    previousStart: dateStart(previousDate, timeZone).toISOString(),
    timeZone,
  };
}
