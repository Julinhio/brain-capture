import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CalendarDay, CalendarEvent, CalendarSource, DayWindow } from '../../shared/dashboard.js';
import type { AppDeps } from '../app.js';
import { calendarConnections, captureEvents } from '../db/schema.js';
import { sendError } from '../http.js';
import { dayWindow } from './day.js';

const EVENTS_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const EVENTS_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
/**
 * Requested at every (re)connection. `calendar.events` reads events for the dashboard and
 * creates the events confirmed from captures; the calendar list stays read-only.
 */
export const CALENDAR_SCOPES = [EVENTS_WRITE_SCOPE, CALENDAR_LIST_SCOPE];

function granted(scopes: string): Set<string> {
  return new Set(scopes.split(' ').filter(Boolean));
}
/** Grants made before writing existed (events read-only) keep the dashboard working. */
export function canReadCalendars(scopes: string): boolean {
  const g = granted(scopes);
  return g.has(CALENDAR_LIST_SCOPE) && (g.has(EVENTS_WRITE_SCOPE) || g.has(EVENTS_READ_SCOPE));
}
export function canWriteEvents(scopes: string): boolean {
  return granted(scopes).has(EVENTS_WRITE_SCOPE);
}

/**
 * Where the OAuth callback sends the browser back: a path of this app only (the capture a
 * reconnection started from), never another origin. Anything else falls back to "/".
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return '/';
  try {
    const u = new URL(value, 'http://app.invalid');
    return u.origin === 'http://app.invalid' ? u.pathname + u.search : '/';
  } catch {
    return '/';
  }
}
function withResult(path: string, result: 'connected' | 'failed'): string {
  const u = new URL(path, 'http://app.invalid');
  u.searchParams.set('calendar', result);
  return u.pathname + u.search;
}

/** An authorised Google client for the stored connection. */
export function calendarClient(
  settings: NonNullable<AppDeps['config']['calendar']>,
  connection: { refreshToken: string },
): OAuth2Client {
  const client = new OAuth2Client({
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    redirectUri: settings.redirectUri,
  });
  client.setCredentials({ refresh_token: unseal(connection.refreshToken, settings.encryptionKey) });
  return client;
}
const STATE_COOKIE = 'bc_calendar_state';
export function seal(value: string, hexKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64url')).join('.');
}
export function unseal(value: string, hexKey: string): string {
  const [iv, tag, encrypted] = value.split('.').map((s) => Buffer.from(s, 'base64url'));
  if (!iv || !tag || !encrypted) throw new Error('Invalid encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

const googleEvent = z.object({
  id: z.string(),
  summary: z.string().optional(),
  status: z.string().optional(),
  htmlLink: z.string().optional(),
  transparency: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
  attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
});
const eventsPage = z.object({ items: z.array(googleEvent).default([]), nextPageToken: z.string().optional() });
export function safeGoogleUrl(value?: string): string | null {
  try {
    const u = new URL(value!);
    return u.protocol === 'https:' && ['calendar.google.com', 'www.google.com'].includes(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

export async function calendarEvents(
  client: OAuth2Client,
  window: DayWindow,
  calendarId: string,
  deadline = Date.now() + 25_000,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let next: string | undefined;
  // Follow all pages; on an unexpectedly huge calendar fail visibly instead of claiming
  // that a truncated response describes the whole day.
  for (let page = 0; page < 20; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Calendar reading timed out');
    const response = await client.request({
      url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      params: {
        timeMin: window.start,
        timeMax: window.end,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
        timeZone: window.timeZone,
        ...(next ? { pageToken: next } : {}),
      },
      timeout: Math.min(10_000, remaining),
      retry: false,
    });
    const body = eventsPage.parse(response.data);
    for (const e of body.items) {
      if (e.status === 'cancelled' || e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;
      const start = e.start.dateTime ?? e.start.date;
      const end = e.end.dateTime ?? e.end.date;
      if (!start || !end) continue;
      events.push({
        id: e.id,
        title: e.summary || 'Untitled event',
        start,
        end,
        allDay: !e.start.dateTime,
        busy: e.transparency !== 'transparent',
        url: safeGoogleUrl(e.htmlLink),
      });
    }
    next = body.nextPageToken;
    if (!next) return events;
  }
  throw new Error('Calendar pagination limit reached');
}

const listPage = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(2000),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        backgroundColor: z.string().optional(),
        accessRole: z.string(),
        hidden: z.boolean().optional(),
        deleted: z.boolean().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});
export type ListedCalendar = Pick<CalendarSource, 'id' | 'name' | 'color' | 'owned'> & { hidden: boolean };
export async function listCalendars(client: OAuth2Client, deadline = Date.now() + 25_000): Promise<ListedCalendar[]> {
  const calendars = new Map<string, ListedCalendar>();
  let next: string | undefined;
  for (let page = 0; page < 20; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Calendar discovery timed out');
    const response = await client.request({
      url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      params: {
        maxResults: 250,
        minAccessRole: 'reader',
        showHidden: true,
        showDeleted: false,
        ...(next ? { pageToken: next } : {}),
      },
      timeout: Math.min(10_000, remaining),
      retry: false,
    });
    const body = listPage.parse(response.data);
    for (const c of body.items) {
      if (c.deleted || !['owner', 'writer', 'writerWithoutPrivateAccess', 'reader'].includes(c.accessRole)) continue;
      calendars.set(c.id, {
        id: c.id,
        name: c.summaryOverride || c.summary || 'Untitled calendar',
        color: /^#[a-f0-9]{6}$/i.test(c.backgroundColor ?? '') ? c.backgroundColor! : '#ffad52',
        owned: c.accessRole === 'owner',
        hidden: c.hidden ?? false,
      });
    }
    next = body.nextPageToken;
    if (!next)
      return [...calendars.values()].sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name));
  }
  throw new Error('Calendar discovery pagination limit reached');
}

export async function readCalendarDay(
  client: OAuth2Client,
  window: DayWindow,
  selectedIds: string[] | null,
): Promise<CalendarDay> {
  const deadline = Date.now() + 25_000;
  const available = await listCalendars(client, deadline);
  const selected =
    selectedIds === null
      ? new Set(available.filter((c) => c.owned && !c.hidden).map((c) => c.id))
      : new Set(selectedIds);
  const missingCalendarCount = [...selected].filter((id) => !available.some((c) => c.id === id)).length;
  const calendars: CalendarSource[] = available.map(({ hidden: _hidden, ...c }) => ({
    ...c,
    selected: selected.has(c.id),
    loadState: selected.has(c.id) ? 'error' : 'off',
  }));
  const pending = calendars.filter((c) => c.selected);
  const events: CalendarEvent[] = [];
  let cursor = 0;
  // Bound concurrency and use one shared deadline. One bad source never becomes
  // an empty successful calendar, nor hides the successfully read sources.
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (cursor < pending.length) {
        const source = pending[cursor++]!;
        try {
          const rows = await calendarEvents(client, window, source.id, deadline);
          events.push(
            ...rows.map((event) => ({
              ...event,
              id: JSON.stringify([source.id, event.id]),
              calendarId: source.id,
              calendarName: source.name,
              calendarColor: source.color,
            })),
          );
          source.loadState = 'ready';
        } catch {
          source.loadState = 'error';
        }
      }
    }),
  );
  events.sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  );
  return {
    state: missingCalendarCount || pending.some((c) => c.loadState === 'error') ? 'partial' : 'ready',
    checkedAt: new Date().toISOString(),
    calendars,
    missingCalendarCount,
    events,
  };
}

export function registerCalendarRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  const settings = config.calendar;
  const oauth = () =>
    new OAuth2Client({
      clientId: settings!.clientId,
      clientSecret: settings!.clientSecret,
      redirectUri: settings!.redirectUri,
    });
  // State contains PKCE verifier + signed-in owner. Encrypted cookie has a short lifetime
  // and callback requires the same authenticated session, closing login-CSRF.
  app.post('/api/calendar/connect', async (req, reply) => {
    if (!settings) return sendError(reply, 503, 'internal', 'The Google connection is not configured yet.');
    const returnTo = safeReturnPath((req.body as { returnTo?: unknown } | undefined)?.returnTo);
    const client = oauth();
    const state = randomBytes(32).toString('base64url');
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    reply.setCookie(
      STATE_COOKIE,
      seal(
        JSON.stringify({ state, codeVerifier, owner: req.user!.id, expires: Date.now() + 600_000, returnTo }),
        settings.encryptionKey,
      ),
      {
        path: '/api/calendar/callback',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.env === 'production',
        maxAge: 600,
      },
    );
    return {
      url: client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: CALENDAR_SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
      }),
    };
  });
  app.get('/api/calendar/callback', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const cookie = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/api/calendar/callback' });
    const query = req.query as { state?: string; code?: string; error?: string };
    if (!settings || !cookie) return reply.redirect('/?calendar=failed');
    let returnTo = '/';
    try {
      const state = z
        .object({
          state: z.string(),
          codeVerifier: z.string(),
          owner: z.uuid(),
          expires: z.number(),
          returnTo: z.string().optional(),
        })
        .parse(JSON.parse(unseal(cookie, settings.encryptionKey)));
      returnTo = safeReturnPath(state.returnTo ?? '/');
      const returned = Buffer.from(query.state ?? '');
      const expected = Buffer.from(state.state);
      if (
        state.owner !== req.user!.id ||
        state.expires < Date.now() ||
        returned.length !== expected.length ||
        !timingSafeEqual(returned, expected) ||
        !query.code ||
        query.error
      )
        throw new Error('Invalid OAuth callback');
      const client = oauth();
      const { tokens } = await client.getToken({ code: query.code, codeVerifier: state.codeVerifier });
      if (!tokens.refresh_token || !CALENDAR_SCOPES.every((scope) => tokens.scope?.split(' ').includes(scope)))
        throw new Error('Missing calendar permission');
      await db
        .insert(calendarConnections)
        .values({
          ownerId: req.user!.id,
          refreshToken: seal(tokens.refresh_token, settings.encryptionKey),
          grantedScopes: tokens.scope!,
        })
        .onConflictDoUpdate({
          target: calendarConnections.ownerId,
          set: {
            refreshToken: seal(tokens.refresh_token, settings.encryptionKey),
            grantedScopes: tokens.scope!,
            updatedAt: new Date(),
          },
        });
      // An earlier "reconnect" failure on a capture is now resolved: stop asking for it.
      await db
        .update(captureEvents)
        .set({ lastError: null })
        .where(and(eq(captureEvents.ownerId, req.user!.id), sql`${captureEvents.lastError}->>'code' = 'calendar_reconnect'`));
      return reply.redirect(withResult(returnTo, 'connected'));
    } catch {
      return reply.redirect(withResult(returnTo, 'failed'));
    }
  });
  app.delete('/api/calendar/connection', async (req) => {
    // Removing the local token stops all future access. Google account permission can
    // separately be revoked from Google's account settings, without affecting other apps.
    await db.delete(calendarConnections).where(eq(calendarConnections.ownerId, req.user!.id));
    return { ok: true };
  });
  app.patch('/api/calendar/selection', async (req, reply) => {
    const body = z
      .object({ calendarIds: z.array(z.string().min(1).max(2000)).max(100).nullable() })
      .strict()
      .safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', 'Invalid calendar selection.');
    const [connection] = await db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.ownerId, req.user!.id));
    if (!settings || !connection)
      return sendError(reply, 400, 'invalid_input', 'Connect Google Calendar before choosing your calendars.');
    if (!canReadCalendars(connection.grantedScopes))
      return sendError(reply, 400, 'invalid_input', 'Reconnect Google to allow reading your calendar list.');
    try {
      const client = calendarClient(settings, connection);
      const available = await listCalendars(client);
      if (body.data.calendarIds?.some((id) => !available.some((c) => c.id === id)))
        return sendError(
          reply,
          400,
          'invalid_input',
          'A chosen calendar is no longer accessible. Refresh the list.',
        );
      await db
        .update(calendarConnections)
        .set({
          calendarIds: body.data.calendarIds === null ? null : [...new Set(body.data.calendarIds)],
          updatedAt: new Date(),
        })
        .where(eq(calendarConnections.ownerId, req.user!.id));
      return { ok: true };
    } catch {
      return sendError(reply, 503, 'internal', 'The selection was not saved. Try again in a moment.');
    }
  });
  app.get('/api/calendar/day', async (req, reply): Promise<CalendarDay | unknown> => {
    reply.header('Cache-Control', 'no-store');
    const empty = { checkedAt: null, events: [], calendars: [] };
    if (!settings) return { ...empty, state: 'unconfigured' };
    let window;
    try {
      window = dayWindow(
        z
          .string()
          .max(100)
          .parse((req.query as { timeZone?: string }).timeZone ?? 'Europe/Paris'),
      );
    } catch {
      return sendError(reply, 400, 'invalid_input', 'Invalid time zone.');
    }
    const [connection] = await db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.ownerId, req.user!.id));
    if (!connection) return { ...empty, state: 'disconnected' };
    if (!canReadCalendars(connection.grantedScopes)) return { ...empty, state: 'permission_required' };
    try {
      const client = calendarClient(settings, connection);
      return await readCalendarDay(client, window, connection.calendarIds);
    } catch {
      return { ...empty, state: 'error' };
    }
  });
}
