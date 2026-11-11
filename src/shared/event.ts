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

/** Start plus the default duration, as a wall clock in the start zone. */
export function defaultEnd(start: string, timeZone: string): string {
  return wallClock(new Date(zonedToUtc(start, timeZone).getTime() + DEFAULT_DURATION_MIN * 60_000), timeZone);
}

/** Null when the draft can be sent to Google; otherwise a sentence for the card. */
export function draftProblem(d: EventDraft): string | null {
  if (!d.title.trim()) return 'Donne un titre à l’événement.';
  if (d.title.trim().length > MAX_EVENT_TITLE) return 'Le titre est trop long.';
  if (d.location && d.location.length > MAX_EVENT_LOCATION) return 'Le lieu est trop long.';
  if (!d.start) return 'Choisis la date de l’événement.';
  if (!d.end) return 'Choisis la fin de l’événement.';
  if (d.allDay) {
    if (!isRealDate(d.start) || !isRealDate(d.end)) return 'Date invalide.';
    if (d.end < d.start) return 'La fin est avant le début.';
    if (Date.parse(d.end) - Date.parse(d.start) > MAX_SPAN_DAYS * 86_400_000) return 'L’événement dépasse un mois.';
    return null;
  }
  if (!isRealDateTime(d.start) || !isRealDateTime(d.end)) return 'Date ou heure invalide.';
  if (!isValidTimeZone(d.startTimeZone) || !isValidTimeZone(d.endTimeZone)) return 'Fuseau horaire inconnu.';
  const span = zonedToUtc(d.end, d.endTimeZone).getTime() - zonedToUtc(d.start, d.startTimeZone).getTime();
  if (span <= 0) return 'La fin doit être après le début.';
  if (span > MAX_SPAN_DAYS * 86_400_000) return 'L’événement dépasse un mois.';
  return null;
}
