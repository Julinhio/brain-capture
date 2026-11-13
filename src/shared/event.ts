// A calendar event proposed from a capture. Shared by the server (normalising the model's
// answer, building the Google request) and the app (the editable card), so both apply the
// same rules. Times are wall-clock values in their own IANA zone: a flight leaves at 08:30
// Paris time and lands at 10:05 Lisbon time, as on a boarding pass.

export interface EventDraft {
  title: string;
  allDay: boolean;
  /** `YYYY-MM-DD` when allDay, otherwise `YYYY-MM-DDTHH:mm`. Null until a date is known. */
  start: string | null;
  /** Same format as start. For all-day events this is the last day, inclusive. */
  end: string | null;
  startTimeZone: string;
  endTimeZone: string;
  location: string | null;
}

export type CaptureEventState = 'proposed' | 'created' | 'dismissed';
/** Whether the app can write to Google right now, read from the stored grant only. */
export type CalendarWriteAccess = 'ready' | 'reconnect' | 'disconnected' | 'unconfigured';

export interface CaptureEvent {
  state: CaptureEventState;
  draft: EventDraft;
  /** `failed`: the model could not be asked or answered unusably; the fields are a starting point. */
  extraction: 'done' | 'failed';
  lastError: { code: string; message: string } | null;
  eventUrl: string | null;
  createdInCalendarAt: string | null;
}

export interface CaptureEventResponse {
  event: CaptureEvent | null;
  access: CalendarWriteAccess;
  /**
   * The event is in Google and the capture no longer exists in Brain Capture: a calendar
   * request is not a task. Its original words are in the event description.
   */
  captureDeleted?: boolean;
}

/** When no end is said: one hour for a timed event, the same day for an all-day one. */
export const DEFAULT_DURATION_MIN = 60;
export const MAX_EVENT_TITLE = 200;
export const MAX_EVENT_LOCATION = 300;
const MAX_SPAN_DAYS = 31;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function isRealDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function isRealDateTime(value: string): boolean {
  if (!DATE_TIME_RE.test(value) || !isRealDate(value.slice(0, 10))) return false;
  const [h, m] = value.slice(11).split(':').map(Number);
  return h! < 24 && m! < 60;
}

/** Local wall clock (`YYYY-MM-DDTHH:mm`) of an instant in a zone. */
export function wallClock(instant: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * The instant at which the wall clock in `timeZone` reads `local`. Two passes settle the
 * offset across DST changes; a time skipped by a spring-forward lands just after the gap.
 */
export function zonedToUtc(local: string, timeZone: string): Date {
  const asUtc = Date.parse(`${local}:00Z`);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const seen = Date.parse(`${wallClock(new Date(guess), timeZone)}:00Z`);
    guess += asUtc - seen;
  }
  return new Date(guess);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Start plus the default duration, as a wall clock in the start zone. On the night the clocks
 * go back, one hour after 01:30 can read 01:30 again: the wall clock alone cannot say which
 * one, so the end moves to the next distinct hour (02:30) and stays after the start.
 */
export function defaultEnd(start: string, timeZone: string): string {
  const at = zonedToUtc(start, timeZone).getTime();
  for (const minutes of [DEFAULT_DURATION_MIN, DEFAULT_DURATION_MIN + 60]) {
    const end = wallClock(new Date(at + minutes * 60_000), timeZone);
    if (end > start) return end;
  }
  return wallClock(new Date(at + (DEFAULT_DURATION_MIN + 120) * 60_000), timeZone);
}

/** Null when the draft can be sent to Google; otherwise a sentence for the card. */
export function draftProblem(d: EventDraft): string | null {
  if (!d.title.trim()) return 'Give the event a title.';
  if (d.title.trim().length > MAX_EVENT_TITLE) return 'The title is too long.';
  if (d.location && d.location.length > MAX_EVENT_LOCATION) return 'The location is too long.';
  if (!d.start) return 'Choose the date of the event.';
  if (!d.end) return 'Choose when the event ends.';
  if (d.allDay) {
    if (!isRealDate(d.start) || !isRealDate(d.end)) return 'Invalid date.';
    if (d.end < d.start) return 'The end is before the start.';
    if (Date.parse(d.end) - Date.parse(d.start) > MAX_SPAN_DAYS * 86_400_000) return 'The event is longer than a month.';
    return null;
  }
  if (!isRealDateTime(d.start) || !isRealDateTime(d.end)) return 'Invalid date or time.';
  if (!isValidTimeZone(d.startTimeZone) || !isValidTimeZone(d.endTimeZone)) return 'Unknown time zone.';
  const span = zonedToUtc(d.end, d.endTimeZone).getTime() - zonedToUtc(d.start, d.startTimeZone).getTime();
  if (span <= 0) return 'The end must be after the start.';
  if (span > MAX_SPAN_DAYS * 86_400_000) return 'The event is longer than a month.';
  return null;
}
