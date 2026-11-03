import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CalendarDay, CalendarEvent, DayWindow } from '../../shared/dashboard.js';
import type { AppDeps } from '../app.js';
import { calendarConnections } from '../db/schema.js';
import { sendError } from '../http.js';
import { dayWindow } from './day.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
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
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let next: string | undefined;
  // Follow all pages; on an unexpectedly huge calendar fail visibly instead of claiming
  // that a truncated response describes the whole day.
  for (let page = 0; page < 20; page++) {
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
      timeout: 10_000,
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
        title: e.summary || 'Événement sans titre',
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
    if (!settings) return sendError(reply, 503, 'internal', 'La connexion Google n’est pas encore configurée.');
    const client = oauth();
    const state = randomBytes(32).toString('base64url');
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    reply.setCookie(
      STATE_COOKIE,
      seal(
        JSON.stringify({ state, codeVerifier, owner: req.user!.id, expires: Date.now() + 600_000 }),
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
        scope: [SCOPE],
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
    try {
      const state = z
        .object({ state: z.string(), codeVerifier: z.string(), owner: z.uuid(), expires: z.number() })
        .parse(JSON.parse(unseal(cookie, settings.encryptionKey)));
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
      if (!tokens.refresh_token || !tokens.scope?.split(' ').includes(SCOPE))
        throw new Error('Missing calendar permission');
      await db
        .insert(calendarConnections)
        .values({ ownerId: req.user!.id, refreshToken: seal(tokens.refresh_token, settings.encryptionKey) })
        .onConflictDoUpdate({
          target: calendarConnections.ownerId,
          set: { refreshToken: seal(tokens.refresh_token, settings.encryptionKey), updatedAt: new Date() },
        });
      return reply.redirect('/?calendar=connected');
    } catch {
      return reply.redirect('/?calendar=failed');
    }
  });
  app.delete('/api/calendar/connection', async (req) => {
    // Removing the local token stops all future access. Google account permission can
    // separately be revoked from Google's account settings, without affecting other apps.
    await db.delete(calendarConnections).where(eq(calendarConnections.ownerId, req.user!.id));
    return { ok: true };
  });
  app.get('/api/calendar/day', async (req, reply): Promise<CalendarDay | unknown> => {
    reply.header('Cache-Control', 'no-store');
    const empty = { checkedAt: null, events: [] };
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
      return sendError(reply, 400, 'invalid_input', 'Fuseau horaire invalide.');
    }
    const [connection] = await db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.ownerId, req.user!.id));
    if (!connection) return { ...empty, state: 'disconnected' };
    try {
      const client = oauth();
      client.setCredentials({ refresh_token: unseal(connection.refreshToken, settings.encryptionKey) });
      const events = await calendarEvents(client, window, settings.calendarId);
      return { state: 'ready', checkedAt: new Date().toISOString(), events };
    } catch {
      return { ...empty, state: 'error' };
    }
  });
}
