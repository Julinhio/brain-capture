import { and, eq, ne } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import {
  addDays,
  draftProblem,
  isValidTimeZone,
  MAX_EVENT_LOCATION,
  MAX_EVENT_TITLE,
  type CalendarWriteAccess,
  type CaptureEvent,
  type CaptureEventResponse,
  type EventDraft,
} from '../../shared/event.js';
import { fallbackTitle } from '../../shared/text.js';
import type { ApiErrorCode } from '../../shared/types.js';
import { emptyDraft, looksLikeCalendarRequest, normalizeExtraction } from '../ai/event-prompt.js';
import type { Ai } from '../ai/types.js';
import type { AppDeps } from '../app.js';
import type { Config } from '../config.js';
import { calendarClient, canWriteEvents, safeGoogleUrl } from '../dashboard/calendar.js';
import type { Db } from '../db/client.js';
import {
  calendarConnections,
  captureEvents,
  captures,
  type CaptureEventRow,
  type CaptureRow,
  type DeletedCaptureRow,
} from '../db/schema.js';
import { sendError } from '../http.js';
import { deleteCapture, findDeletedById } from './service.js';

/** Events go to the account's main calendar (Google's `primary` alias). */
export const TARGET_CALENDAR = 'primary';
const GOOGLE_TIMEOUT_MS = 15_000;
const FALLBACK_TIME_ZONE = 'Europe/Paris';

/**
 * Google lets the client choose the event id (base32hex: 0-9 and a-v). Deriving it from the
 * capture makes creation idempotent at Google's end: a double tap, a retry after a lost
 * response or a crash between Google's answer and our write all hit the same id, and Google
 * answers 409 instead of creating a second event.
 */
export function googleEventId(captureId: string): string {
  return `bc${captureId.replace(/-/g, '').toLowerCase()}`;
}

export function toCaptureEvent(row: CaptureEventRow): CaptureEvent {
  return {
    state: row.state,
    draft: row.draft,
    extraction: row.extraction,
    lastError: row.lastError ?? null,
    eventUrl: row.eventUrl,
    createdInCalendarAt: row.createdInCalendarAt?.toISOString() ?? null,
  };
}

/** The event a capture turned into, read from what is left of the capture once deleted. */
export function eventFromTombstone(row: DeletedCaptureRow): CaptureEvent | null {
  if (row.reason !== 'calendar' || !row.calendarEvent) return null;
  return {
    state: 'created',
    draft: row.calendarEvent.draft,
    extraction: 'done',
    lastError: null,
    eventUrl: row.calendarEvent.eventUrl,
    createdInCalendarAt: row.calendarEvent.createdInCalendarAt,
  };
}

// ---------------------------------------------------------------------------------------
// Capture context: the phone's clock and zone at capture time. Old app versions do not send
// them; a clock wildly off from the server's is ignored rather than trusted.
// ---------------------------------------------------------------------------------------

export interface CaptureContext {
  reference: Date;
  timeZone: string;
}

export function captureContext(capturedAt: number | undefined, timeZone: string | undefined, now = new Date()): CaptureContext {
  const plausible =
    capturedAt !== undefined &&
    Number.isFinite(capturedAt) &&
    capturedAt <= now.getTime() + 10 * 60_000 &&
    capturedAt >= now.getTime() - 400 * 86_400_000;
  return {
    reference: plausible ? new Date(capturedAt) : now,
    timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIME_ZONE,
  };
}

// ---------------------------------------------------------------------------------------
// Proposal: runs right after a capture is stored. Never throws: the capture is already safe,
// and a missing proposal must not turn its save into an error.
// ---------------------------------------------------------------------------------------

export async function proposeEvent(
  db: Db,
  ai: Ai,
  capture: CaptureRow,
  context: CaptureContext,
  log?: FastifyBaseLogger,
): Promise<CaptureEventRow | null> {
  try {
    if (!looksLikeCalendarRequest(capture.originalText)) return null;
    const [existing] = await db.select().from(captureEvents).where(eq(captureEvents.captureId, capture.id));
    if (existing) return existing;

    const title = capture.title ?? fallbackTitle(capture.originalText, null);
    let draft: EventDraft;
    let extraction: 'done' | 'failed' = 'done';
    try {
      if (!ai.available) throw new Error('No AI provider configured');
      const answer = await ai.extractEvent({ text: capture.originalText, ...context });
      // The words looked like a request, the model reads the whole note and says it is not one.
      if (!answer.isEventRequest) return null;
      draft = normalizeExtraction(answer, { timeZone: context.timeZone, fallbackTitle: title });
    } catch (err) {
      log?.warn({ err: (err as Error).message, captureId: capture.id }, 'event extraction failed');
      draft = emptyDraft(context.timeZone, title);
      extraction = 'failed';
    }
    const [inserted] = await db
      .insert(captureEvents)
      .values({
        captureId: capture.id,
        ownerId: capture.ownerId,
        extraction,
        draft,
        referenceAt: context.reference,
        timeZone: context.timeZone,
      })
      .onConflictDoNothing({ target: captureEvents.captureId })
      .returning();
    if (inserted) return inserted;
    const [winner] = await db.select().from(captureEvents).where(eq(captureEvents.captureId, capture.id));
    return winner ?? null;
  } catch (err) {
    log?.error({ err, captureId: capture.id }, 'event proposal failed');
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Google side.
// ---------------------------------------------------------------------------------------

export function googleEventBody(draft: EventDraft, description: string, captureId: string) {
  const when = draft.allDay
    ? // Google's all-day end date is exclusive; the card shows the last day.
      { start: { date: draft.start! }, end: { date: addDays(draft.end!, 1) } }
    : {
        start: { dateTime: `${draft.start}:00`, timeZone: draft.startTimeZone },
        end: { dateTime: `${draft.end}:00`, timeZone: draft.endTimeZone },
      };
  return {
    summary: draft.title.trim(),
    ...(draft.location?.trim() ? { location: draft.location.trim() } : {}),
    description,
    ...when,
    extendedProperties: { private: { brainCaptureId: captureId } },
  };
}

const createdEvent = z.object({ id: z.string(), status: z.string().optional(), htmlLink: z.string().optional() });

function httpStatus(err: unknown): number | undefined {
  const e = err as { response?: { status?: unknown }; status?: unknown };
  const status = e?.response?.status ?? e?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Creates the event once. A repeat with the same id gets a 409: the event already exists
 * because an earlier attempt never received its answer. It is then brought in line with the
 * draft being confirmed now (Julien may have corrected it before retrying), and restored if
 * it was deleted in Google meanwhile. Still one event, showing what the card shows.
 */
export async function insertGoogleEvent(
  client: Pick<OAuth2Client, 'request'>,
  calendarId: string,
  eventId: string,
  body: ReturnType<typeof googleEventBody>,
): Promise<z.infer<typeof createdEvent>> {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  try {
    const res = await client.request({ url: base, method: 'POST', data: { ...body, id: eventId }, timeout: GOOGLE_TIMEOUT_MS, retry: false });
    return createdEvent.parse(res.data);
  } catch (err) {
    if (httpStatus(err) !== 409) throw err;
  }
  const url = `${base}/${encodeURIComponent(eventId)}`;
  const updated = await client.request({
    url,
    method: 'PUT',
    data: { ...body, id: eventId, status: 'confirmed' },
    timeout: GOOGLE_TIMEOUT_MS,
    retry: false,
  });
  return createdEvent.parse(updated.data);
}

export interface EventFailure {
  status: number;
  code: ApiErrorCode;
  message: string;
}

const RECONNECT = 'Your Google connection expired or was removed. Reconnect your Google account.';

/** Turns a Google failure into something Julien can act on. Never echoes tokens. */
export function describeGoogleError(err: unknown): EventFailure {
  const e = err as { message?: string; response?: { data?: unknown } };
  const data = e?.response?.data as
    | { error?: string | { message?: string; status?: string; errors?: { reason?: string }[] }; error_description?: string }
    | undefined;
  const status = httpStatus(err);
  const apiError = typeof data?.error === 'object' ? data.error : undefined;
  const reasons = new Set((apiError?.errors ?? []).map((r) => r.reason).filter(Boolean));

  if (data?.error === 'invalid_grant' || /invalid_grant/.test(e?.message ?? '') || status === 401)
    return { status: 403, code: 'calendar_reconnect', message: RECONNECT };
  if (status === 429 || ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].some((r) => reasons.has(r)))
    return { status: 503, code: 'calendar_unavailable', message: 'Google is limiting requests right now. Try again in a minute.' };
  if (status === 403)
    return {
      status: 403,
      code: 'calendar_reconnect',
      message: 'Google refused to add it to your calendar. Reconnect Google and allow access to events.',
    };
  if (status === 400) {
    const detail = (apiError?.message ?? '').replace(/\s+/g, ' ').slice(0, 200);
    return { status: 400, code: 'invalid_input', message: `Google refused this event${detail ? `: ${detail}` : '.'}` };
  }
  if (status === 404)
    return { status: 503, code: 'calendar_unavailable', message: 'Your main calendar was not found at Google.' };
  return { status: 503, code: 'calendar_unavailable', message: 'Google Calendar is not responding. Try again in a moment.' };
}

async function writeAccess(db: Db, config: Config, ownerId: string): Promise<CalendarWriteAccess> {
  if (!config.calendar) return 'unconfigured';
  const [connection] = await db.select().from(calendarConnections).where(eq(calendarConnections.ownerId, ownerId));
  if (!connection) return 'disconnected';
  return canWriteEvents(connection.grantedScopes) ? 'ready' : 'reconnect';
}

/**
 * `captureDeleted`: the event is in Google and the capture is gone from Brain Capture (a
 * calendar request is not a task). Its original words are in the event description.
 */
export type ConfirmResult = { ok: true; event: CaptureEvent; captureDeleted: boolean } | ({ ok: false } & EventFailure);

// One confirmation at a time per capture, Google call included: two devices confirming
// different versions at once would otherwise race, and the card could end up showing a
// version other than the one Google kept. The app runs as a single server process (one
// Railway service); with several, this would need a database lock instead.
const confirming = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = confirming.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => undefined);
  confirming.set(key, settled);
  try {
    return await run;
  } finally {
    if (confirming.get(key) === settled) confirming.delete(key);
  }
}

/**
 * Creates the confirmed event in Google, at most once per capture. Already created: returns
 * it without calling Google. Any failure is stored on the proposal, so it is still visible
 * when the capture is opened again later.
 */
export async function confirmEvent(
  db: Db,
  config: Config,
  ownerId: string,
  captureId: string,
  draft: EventDraft,
  log?: FastifyBaseLogger,
): Promise<ConfirmResult> {
  return oneAtATime(captureId, () => confirmNow(db, config, ownerId, captureId, draft, log));
}

async function confirmNow(
  db: Db,
  config: Config,
  ownerId: string,
  captureId: string,
  draft: EventDraft,
  log?: FastifyBaseLogger,
): Promise<ConfirmResult> {
  const [row] = await db
    .select()
    .from(captureEvents)
    .where(and(eq(captureEvents.captureId, captureId), eq(captureEvents.ownerId, ownerId)));
  if (!row) {
    // Already turned into an event and removed (a double tap, or a retry after a lost answer):
    // answer with that event, never call Google again.
    const tombstone = await findDeletedById(db, ownerId, captureId);
    const done = tombstone ? eventFromTombstone(tombstone) : null;
    if (done) return { ok: true, event: done, captureDeleted: true };
    return { ok: false, status: 404, code: 'not_found', message: 'No calendar proposal for this capture.' };
  }
  // Created before calendar requests stopped being kept as captures: left as it is.
  if (row.state === 'created') return { ok: true, event: toCaptureEvent(row), captureDeleted: false };
  const problem = draftProblem(draft);
  if (problem) return { ok: false, status: 400, code: 'invalid_input', message: problem };

  const fail = async (failure: EventFailure): Promise<ConfirmResult> => {
    await db
      .update(captureEvents)
      .set({ lastError: { code: failure.code, message: failure.message }, updatedAt: new Date() })
      .where(and(eq(captureEvents.captureId, captureId), eq(captureEvents.state, row.state)));
    return { ok: false, ...failure };
  };

  // Keep the edits whatever Google answers: reopening the capture shows them again.
  await db
    .update(captureEvents)
    .set({ draft, state: 'proposed', updatedAt: new Date() })
    .where(and(eq(captureEvents.captureId, captureId), eq(captureEvents.state, row.state)));

  const settings = config.calendar;
  if (!settings) return fail({ status: 503, code: 'calendar_unavailable', message: 'The Google connection is not configured on the server.' });
  const [connection] = await db.select().from(calendarConnections).where(eq(calendarConnections.ownerId, ownerId));
  if (!connection) return fail({ status: 403, code: 'calendar_reconnect', message: 'Connect Google Calendar to add this event.' });
  if (!canWriteEvents(connection.grantedScopes))
    return fail({
      status: 403,
      code: 'calendar_reconnect',
      message: 'Brain Capture is not yet allowed to add events. Reconnect Google to allow it.',
    });

  const [capture] = await db.select().from(captures).where(and(eq(captures.id, captureId), eq(captures.ownerId, ownerId)));
  if (!capture) return { ok: false, status: 404, code: 'not_found', message: 'Capture introuvable.' };

  let created: z.infer<typeof createdEvent>;
  try {
    created = await insertGoogleEvent(
      calendarClient(settings, connection),
      TARGET_CALENDAR,
      googleEventId(captureId),
      googleEventBody(draft, capture.originalText, captureId),
    );
  } catch (err) {
    const failure = describeGoogleError(err);
    log?.warn({ status: httpStatus(err), code: failure.code, captureId }, 'calendar event creation failed');
    return fail(failure);
  }
  // Google confirmed the event. Recording it and removing the capture happen in one
  // transaction: either the capture is still there with its proposal (a retry then reaches the
  // same Google event through its fixed id), or it is gone and the tombstone holds the event.
  // There is no state in between where a second event could be created.
  const calendarEvent = {
    // Exactly the version Google now holds.
    draft,
    eventUrl: safeGoogleUrl(created.htmlLink),
    googleEventId: created.id,
    calendarId: TARGET_CALENDAR,
    createdInCalendarAt: new Date().toISOString(),
  };
  await deleteCapture(db, ownerId, captureId, 'calendar', calendarEvent);
  // Deleted by hand while Google was answering: the event exists all the same, say so.
  const tombstone = await findDeletedById(db, ownerId, captureId);
  const event = (tombstone && eventFromTombstone(tombstone)) ?? {
    state: 'created' as const,
    draft,
    extraction: row.extraction,
    lastError: null,
    eventUrl: calendarEvent.eventUrl,
    createdInCalendarAt: calendarEvent.createdInCalendarAt,
  };
  return { ok: true, event, captureDeleted: true };
}

// ---------------------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------------------

const idParams = z.object({ id: z.uuid() });
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);
const draftSchema = z
  .object({
    title: z.string().max(MAX_EVENT_TITLE * 2),
    allDay: z.boolean(),
    start: localDateTime.nullable(),
    end: localDateTime.nullable(),
    startTimeZone: z.string().max(100),
    endTimeZone: z.string().max(100),
    location: z.string().max(MAX_EVENT_LOCATION * 2).nullable(),
  })
  .strict();

function cleanDraft(draft: z.infer<typeof draftSchema>): EventDraft {
  return { ...draft, title: draft.title.trim(), location: draft.location?.trim() || null };
}

export function registerCaptureEventRoutes(app: FastifyInstance, { db, ai, config }: AppDeps): void {
  const ownedEvent = async (ownerId: string, captureId: string) => {
    const [row] = await db
      .select()
      .from(captureEvents)
      .where(and(eq(captureEvents.captureId, captureId), eq(captureEvents.ownerId, ownerId)));
    return row ?? null;
  };
  const respond = async (ownerId: string, row: CaptureEventRow | null): Promise<CaptureEventResponse> => ({
    event: row ? toCaptureEvent(row) : null,
    access: await writeAccess(db, config, ownerId),
  });

  app.get('/api/captures/:id/event', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const row = await ownedEvent(req.user!.id, params.data.id);
    if (!row) {
      const tombstone = await findDeletedById(db, req.user!.id, params.data.id);
      const event = tombstone ? eventFromTombstone(tombstone) : null;
      if (event) return { event, access: await writeAccess(db, config, req.user!.id), captureDeleted: true } satisfies CaptureEventResponse;
    }
    return respond(req.user!.id, row);
  });

  app.post('/api/captures/:id/event', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const body = z.object({ draft: draftSchema }).strict().safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', 'Invalid event.');
    const result = await confirmEvent(db, config, req.user!.id, params.data.id, cleanDraft(body.data.draft), req.log);
    if (!result.ok) return sendError(reply, result.status, result.code, result.message);
    return {
      event: result.event,
      access: await writeAccess(db, config, req.user!.id),
      captureDeleted: result.captureDeleted,
    } satisfies CaptureEventResponse;
  });

  // Dismiss or bring back a proposal, or keep unsent edits (before leaving for Google's
  // consent screen). A created event is left alone: Google holds the truth from then on.
  app.patch('/api/captures/:id/event', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const body = z
      .object({ state: z.enum(['proposed', 'dismissed']).optional(), draft: draftSchema.optional() })
      .strict()
      .refine((b) => b.state || b.draft)
      .safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', 'Invalid change.');
    const owned = and(eq(captureEvents.captureId, params.data.id), eq(captureEvents.ownerId, req.user!.id));
    if (body.data.draft)
      await db
        .update(captureEvents)
        .set({ draft: cleanDraft(body.data.draft), updatedAt: new Date() })
        .where(and(owned, ne(captureEvents.state, 'created')));
    if (body.data.state)
      await db
        .update(captureEvents)
        .set({ state: body.data.state, updatedAt: new Date() })
        .where(and(owned, eq(captureEvents.state, body.data.state === 'dismissed' ? 'proposed' : 'dismissed')));
    return respond(req.user!.id, await ownedEvent(req.user!.id, params.data.id));
  });

  // Asks the model again (after it was unreachable, or to start over from the original words).
  app.post('/api/captures/:id/event/extract', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const row = await ownedEvent(req.user!.id, params.data.id);
    if (!row) return sendError(reply, 404, 'not_found', 'No calendar proposal for this capture.');
    if (row.state === 'created') return respond(req.user!.id, row);
    const [capture] = await db.select().from(captures).where(eq(captures.id, row.captureId));
    if (!capture) return sendError(reply, 404, 'not_found', 'Capture not found.');
    let draft: EventDraft;
    try {
      if (!ai.available) throw new Error('No AI provider configured');
      const answer = await ai.extractEvent({ text: capture.originalText, reference: row.referenceAt, timeZone: row.timeZone });
      draft = normalizeExtraction(answer, { timeZone: row.timeZone, fallbackTitle: row.draft.title });
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'event extraction failed');
      return sendError(reply, 503, 'internal', 'Automatic reading is unavailable. Fill in the fields by hand.');
    }
    const [updated] = await db
      .update(captureEvents)
      .set({ draft, extraction: 'done', updatedAt: new Date() })
      .where(and(eq(captureEvents.captureId, row.captureId), eq(captureEvents.state, row.state)))
      .returning();
    return respond(req.user!.id, updated ?? (await ownedEvent(req.user!.id, params.data.id)));
  });
}
