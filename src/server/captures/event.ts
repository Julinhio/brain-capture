import { and, eq } from 'drizzle-orm';
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
import { calendarConnections, captureEvents, captures, type CaptureEventRow, type CaptureRow } from '../db/schema.js';
import { sendError } from '../http.js';

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

/** Creates the event once. Any repeat with the same id returns the event already there. */
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
  const existing = createdEvent.parse(
    (await client.request({ url, method: 'GET', timeout: GOOGLE_TIMEOUT_MS, retry: false })).data,
  );
  if (existing.status !== 'cancelled') return existing;
  // Created by an earlier attempt that never got its answer, then deleted in Google before
  // this retry: bring that same event back rather than leaving the capture without one.
  const restored = await client.request({
    url,
    method: 'PUT',
    data: { ...body, id: eventId, status: 'confirmed' },
    timeout: GOOGLE_TIMEOUT_MS,
    retry: false,
  });
  return createdEvent.parse(restored.data);
}

export interface EventFailure {
  status: number;
  code: ApiErrorCode;
  message: string;
}

const RECONNECT = 'Ta connexion Google a expiré ou a été retirée. Reconnecte ton compte Google.';

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
    return { status: 503, code: 'calendar_unavailable', message: 'Google limite les requêtes pour le moment. Réessaie dans une minute.' };
  if (status === 403)
    return {
      status: 403,
      code: 'calendar_reconnect',
      message: 'Google refuse l’ajout dans ton agenda. Reconnecte Google et accepte l’accès aux événements.',
    };
  if (status === 400) {
    const detail = (apiError?.message ?? '').replace(/\s+/g, ' ').slice(0, 200);
    return { status: 400, code: 'invalid_input', message: `Google a refusé cet événement${detail ? ` : ${detail}` : '.'}` };
  }
  if (status === 404)
    return { status: 503, code: 'calendar_unavailable', message: 'Ton agenda principal est introuvable chez Google.' };
  return { status: 503, code: 'calendar_unavailable', message: 'Google Agenda ne répond pas. Réessaie dans un instant.' };
}

async function writeAccess(db: Db, config: Config, ownerId: string): Promise<CalendarWriteAccess> {
  if (!config.calendar) return 'unconfigured';
  const [connection] = await db.select().from(calendarConnections).where(eq(calendarConnections.ownerId, ownerId));
  if (!connection) return 'disconnected';
  return canWriteEvents(connection.grantedScopes) ? 'ready' : 'reconnect';
}

export type ConfirmResult = { ok: true; row: CaptureEventRow } | ({ ok: false } & EventFailure);

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
  const [row] = await db
    .select()
    .from(captureEvents)
    .where(and(eq(captureEvents.captureId, captureId), eq(captureEvents.ownerId, ownerId)));
  if (!row) return { ok: false, status: 404, code: 'not_found', message: 'Aucune proposition d’agenda pour cette capture.' };
  if (row.state === 'created') return { ok: true, row };
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
  if (!settings) return fail({ status: 503, code: 'calendar_unavailable', message: 'La connexion Google n’est pas configurée sur le serveur.' });
  const [connection] = await db.select().from(calendarConnections).where(eq(calendarConnections.ownerId, ownerId));
  if (!connection) return fail({ status: 403, code: 'calendar_reconnect', message: 'Connecte Google Agenda pour ajouter cet événement.' });
  if (!canWriteEvents(connection.grantedScopes))
    return fail({
      status: 403,
      code: 'calendar_reconnect',
      message: 'Brain Capture n’a pas encore le droit d’ajouter des événements. Reconnecte Google pour l’autoriser.',
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
  const [saved] = await db
    .update(captureEvents)
    .set({
      state: 'created',
      calendarId: TARGET_CALENDAR,
      googleEventId: created.id,
      eventUrl: safeGoogleUrl(created.htmlLink),
      lastError: null,
      createdInCalendarAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(captureEvents.captureId, captureId))
    .returning();
  return { ok: true, row: saved! };
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
    return respond(req.user!.id, await ownedEvent(req.user!.id, params.data.id));
  });

  app.post('/api/captures/:id/event', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const body = z.object({ draft: draftSchema }).strict().safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', 'Événement invalide.');
    const draft: EventDraft = {
      ...body.data.draft,
      title: body.data.draft.title.trim(),
      location: body.data.draft.location?.trim() || null,
    };
    const result = await confirmEvent(db, config, req.user!.id, params.data.id, draft, req.log);
    if (!result.ok) return sendError(reply, result.status, result.code, result.message);
    return respond(req.user!.id, result.row);
  });

  // Dismiss or bring back a proposal. A created event cannot be dismissed from here.
  app.patch('/api/captures/:id/event', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const body = z.object({ state: z.enum(['proposed', 'dismissed']) }).strict().safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', 'Changement invalide.');
    const [row] = await db
      .update(captureEvents)
      .set({ state: body.data.state, updatedAt: new Date() })
      .where(
        and(
          eq(captureEvents.captureId, params.data.id),
          eq(captureEvents.ownerId, req.user!.id),
          eq(captureEvents.state, body.data.state === 'dismissed' ? 'proposed' : 'dismissed'),
        ),
      )
      .returning();
    return respond(req.user!.id, row ?? (await ownedEvent(req.user!.id, params.data.id)));
  });

  // Asks the model again (after it was unreachable, or to start over from the original words).
  app.post('/api/captures/:id/event/extract', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const row = await ownedEvent(req.user!.id, params.data.id);
    if (!row) return sendError(reply, 404, 'not_found', 'Aucune proposition d’agenda pour cette capture.');
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
      return sendError(reply, 503, 'internal', 'La lecture automatique est indisponible. Complète les champs à la main.');
    }
    const [updated] = await db
      .update(captureEvents)
      .set({ draft, extraction: 'done', updatedAt: new Date() })
      .where(and(eq(captureEvents.captureId, row.captureId), eq(captureEvents.state, row.state)))
      .returning();
    return respond(req.user!.id, updated ?? (await ownedEvent(req.user!.id, params.data.id)));
  });
}
