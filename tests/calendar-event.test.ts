import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { eq } from 'drizzle-orm';
import {
  buildEventMessages,
  looksLikeCalendarRequest,
  normalizeExtraction,
  referenceContext,
} from '../src/server/ai/event-prompt.js';
import type { EventExtraction } from '../src/server/ai/types.js';
import {
  captureContext,
  describeGoogleError,
  googleEventBody,
  googleEventId,
  insertGoogleEvent,
} from '../src/server/captures/event.js';
import { CALENDAR_SCOPES, canReadCalendars, safeReturnPath, seal } from '../src/server/dashboard/calendar.js';
import { calendarConnections, captureEvents } from '../src/server/db/schema.js';
import { draftProblem, zonedToUtc, type EventDraft } from '../src/shared/event.js';
import { createUser, login, newClientId, setup, voicePayload, type TestContext } from './helpers.js';

const PARIS = 'Europe/Paris';
// Wednesday 11 November 2026, 20:15 in Paris.
const WEDNESDAY_EVENING = new Date('2026-11-11T19:15:00Z');

const extraction = (patch: Partial<EventExtraction> = {}): EventExtraction => ({
  isEventRequest: true,
  title: 'Dentiste',
  allDay: false,
  start: '2026-11-17T15:00',
  startTimeZone: null,
  end: null,
  endTimeZone: null,
  location: null,
  ...patch,
});

describe('detection of an explicit calendar request', () => {
  it.each([
    'Mets dans mon agenda dentiste mardi prochain à 15 h',
    'Met dans mon agenda le dîner chez Paul samedi',
    'Ajoute à mon calendrier la réunion Automata demain à 10 h',
    'Rajoute un rendez-vous chez le kiné dans mon agenda jeudi',
    "Inscris l'anniversaire de Marie dans le calendrier",
    'Dans mon agenda, mets padel samedi 9 h',
    'Agenda : comptable lundi 11 h',
    'Add to my calendar lunch with Sarah on Friday',
    'Put the dentist in my calendar next Tuesday at 3pm',
    'Schedule a call with Tom on my calendar tomorrow',
  ])('fires on "%s"', (text) => expect(looksLikeCalendarRequest(text)).toBe(true));

  it.each([
    'Demain, penser à regarder cette offre',
    'Réunion mardi 15 h avec Paul',
    'Dentiste mardi prochain à 15 h',
    'Regarder mon agenda pour la semaine prochaine',
    "Penser à mettre à jour l'agenda partagé",
    'Check my calendar before replying to Tom on Friday',
    "Le calendrier de l'avent des enfants",
    'Ajouter une tâche au backlog pour vendredi',
  ])('stays quiet on "%s"', (text) => expect(looksLikeCalendarRequest(text)).toBe(false));
});

describe('relative dates from the phone clock and zone', () => {
  it('resolves next weekdays from the phone’s local day', () => {
    const ref = referenceContext(WEDNESDAY_EVENING, PARIS);
    expect(ref).toMatchObject({ today: '2026-11-11', time: '20:15', utcOffset: 'UTC+01:00', tomorrow: '2026-11-12' });
    expect(ref.nextWeekday.Tuesday).toBe('2026-11-17');
    // "Mercredi prochain" said on a Wednesday is next week, never today.
    expect(ref.nextWeekday.Wednesday).toBe('2026-11-18');
    expect(ref.nextWeekStart).toBe('2026-11-16');
    expect(ref.days[0]).toEqual({ date: '2026-11-11', fr: 'mercredi', en: 'Wednesday' });
  });

  it('uses the phone zone, not the server’s: the same instant is a different day elsewhere', () => {
    const instant = new Date('2026-11-16T23:30:00Z');
    // Paris: already Tuesday 17 at 00:30, so "mardi prochain" is the 24th.
    expect(referenceContext(instant, PARIS)).toMatchObject({ today: '2026-11-17', nextWeekday: { Tuesday: '2026-11-24' } });
    // New York: still Monday 16, so "mardi prochain" is tomorrow, the 17th.
    expect(referenceContext(instant, 'America/New_York')).toMatchObject({
      today: '2026-11-16',
      nextWeekday: { Tuesday: '2026-11-17' },
      utcOffset: 'UTC-05:00',
    });
    // Da Nang, where Julien may be: Tuesday 06:30.
    expect(referenceContext(instant, 'Asia/Ho_Chi_Minh')).toMatchObject({ today: '2026-11-17', time: '06:30' });
    const prompt = buildEventMessages({ text: 'Mets dans mon agenda dentiste mardi prochain à 15 h', reference: instant, timeZone: PARIS });
    expect(prompt[0]!.content).toContain('mardi / Tuesday = 2026-11-24');
    expect(prompt[0]!.content).toContain('phone time zone Europe/Paris (UTC+01:00)');
    expect(prompt[1]!.content).toContain('dentiste mardi prochain');
  });

  it('ignores an implausible phone clock or zone instead of trusting it', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    expect(captureContext(now.getTime() - 3_600_000, 'Asia/Ho_Chi_Minh', now)).toEqual({
      reference: new Date(now.getTime() - 3_600_000),
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    expect(captureContext(now.getTime() + 86_400_000, 'Mars/Olympus', now)).toEqual({ reference: now, timeZone: PARIS });
    expect(captureContext(undefined, undefined, now)).toEqual({ reference: now, timeZone: PARIS });
  });
});

describe('time zones and the end-time rule', () => {
  it('converts wall clocks to instants across zones and DST', () => {
    expect(zonedToUtc('2026-11-17T15:00', PARIS).toISOString()).toBe('2026-11-17T14:00:00.000Z');
    expect(zonedToUtc('2026-07-01T15:00', PARIS).toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedToUtc('2026-11-17T15:00', 'Asia/Ho_Chi_Minh').toISOString()).toBe('2026-11-17T08:00:00.000Z');
    expect(zonedToUtc('2026-10-25T12:00', PARIS).toISOString()).toBe('2026-10-25T11:00:00.000Z');
  });

  it('defaults to one hour, in the start zone, even across a DST change', () => {
    const d = normalizeExtraction(extraction(), { timeZone: PARIS, fallbackTitle: 'x' });
    expect(d).toMatchObject({ allDay: false, start: '2026-11-17T15:00', end: '2026-11-17T16:00', startTimeZone: PARIS, endTimeZone: PARIS });
    // 29 March 2026: Paris jumps from 02:00 to 03:00, so one hour after 01:30 reads 03:30.
    expect(normalizeExtraction(extraction({ start: '2026-03-29T01:30' }), { timeZone: PARIS, fallbackTitle: 'x' }).end).toBe(
      '2026-03-29T03:30',
    );
    // An end before the start is a misreading: fall back to the rule.
    expect(normalizeExtraction(extraction({ end: '2026-11-17T14:00' }), { timeZone: PARIS, fallbackTitle: 'x' }).end).toBe(
      '2026-11-17T16:00',
    );
  });

  it('keeps a flight’s departure and arrival each in its own zone', () => {
    const d = normalizeExtraction(
      extraction({
        title: 'vol TP433 Paris Lisbonne',
        start: '2026-11-20T08:30',
        startTimeZone: PARIS,
        end: '2026-11-20T10:05',
        endTimeZone: 'Europe/Lisbon',
      }),
      { timeZone: 'Asia/Ho_Chi_Minh', fallbackTitle: 'x' },
    );
    expect(d).toMatchObject({ title: 'Vol TP433 Paris Lisbonne', startTimeZone: PARIS, endTimeZone: 'Europe/Lisbon', end: '2026-11-20T10:05' });
    expect(zonedToUtc(d.start!, d.startTimeZone).toISOString()).toBe('2026-11-20T07:30:00.000Z');
    expect(zonedToUtc(d.end!, d.endTimeZone).toISOString()).toBe('2026-11-20T10:05:00.000Z');
    expect(draftProblem(d)).toBeNull();
    expect(googleEventBody(d, 'texte', 'c')).toMatchObject({
      start: { dateTime: '2026-11-20T08:30:00', timeZone: PARIS },
      end: { dateTime: '2026-11-20T10:05:00', timeZone: 'Europe/Lisbon' },
    });
  });

  it('turns a day without a clock time into an all-day event, end inclusive on the card and exclusive for Google', () => {
    const d = normalizeExtraction(extraction({ title: 'Anniversaire Marie', start: '2026-12-03' }), { timeZone: PARIS, fallbackTitle: 'x' });
    expect(d).toMatchObject({ allDay: true, start: '2026-12-03', end: '2026-12-03' });
    expect(googleEventBody(d, 'Mets dans mon calendrier…', 'c')).toMatchObject({ start: { date: '2026-12-03' }, end: { date: '2026-12-04' } });
  });

  it('falls back to the phone zone for an unknown zone and to the capture title for an empty one', () => {
    const d = normalizeExtraction(extraction({ title: '  ', startTimeZone: 'Not/AZone' }), { timeZone: 'Asia/Tokyo', fallbackTitle: 'Dentiste' });
    expect(d).toMatchObject({ title: 'Dentiste', startTimeZone: 'Asia/Tokyo', endTimeZone: 'Asia/Tokyo' });
  });

  it('rejects drafts Google would refuse or misplace', () => {
    const ok: EventDraft = { title: 'A', allDay: false, start: '2026-11-17T15:00', end: '2026-11-17T16:00', startTimeZone: PARIS, endTimeZone: PARIS, location: null };
    expect(draftProblem(ok)).toBeNull();
    expect(draftProblem({ ...ok, title: ' ' })).toMatch(/titre/);
    expect(draftProblem({ ...ok, start: null })).toMatch(/date/);
    expect(draftProblem({ ...ok, end: '2026-11-17T14:00' })).toMatch(/après le début/);
    // 10:00 in Lisbon is 11:00 in Paris: before an 11:30 Paris start, so invalid.
    expect(draftProblem({ ...ok, start: '2026-11-17T11:30', end: '2026-11-17T10:00', endTimeZone: 'Europe/Lisbon' })).toMatch(/après le début/);
    expect(draftProblem({ ...ok, startTimeZone: 'Nowhere/Here', endTimeZone: 'Nowhere/Here' })).toMatch(/Fuseau/);
    expect(draftProblem({ ...ok, start: '2026-02-30T10:00' })).toMatch(/invalide/);
  });
});

describe('Google side, at most once', () => {
  const body = googleEventBody(
    { title: 'Dentiste', allDay: false, start: '2026-11-17T15:00', end: '2026-11-17T16:00', startTimeZone: PARIS, endTimeZone: PARIS, location: null },
    'Mets dans mon agenda dentiste mardi prochain à 15 h',
    '7f9c2a4e-1d3b-4c5a-9e8f-0a1b2c3d4e5f',
  );
  const gaxios = (status: number, data: unknown = {}) => Object.assign(new Error(`status ${status}`), { response: { status, data } });

  it('derives a valid Google event id from the capture', () => {
    expect(googleEventId('7F9C2A4E-1D3B-4C5A-9E8F-0A1B2C3D4E5F')).toBe('bc7f9c2a4e1d3b4c5a9e8f0a1b2c3d4e5f');
    expect(googleEventId('7f9c2a4e-1d3b-4c5a-9e8f-0a1b2c3d4e5f')).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it('returns the event already there when Google says the id exists', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(gaxios(409))
      .mockResolvedValueOnce({ data: { id: 'bc1', status: 'confirmed', htmlLink: 'https://www.google.com/calendar/event?eid=1' } });
    const event = await insertGoogleEvent({ request } as never, 'primary', 'bc1', body);
    expect(event.id).toBe('bc1');
    expect(request.mock.calls.map(([r]) => r.method)).toEqual(['POST', 'GET']);
    expect(request.mock.calls[0]![0].data).toMatchObject({ id: 'bc1', description: 'Mets dans mon agenda dentiste mardi prochain à 15 h' });
  });

  it('restores the same event if it was deleted in Google before the retry, never a second one', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(gaxios(409))
      .mockResolvedValueOnce({ data: { id: 'bc1', status: 'cancelled' } })
      .mockResolvedValueOnce({ data: { id: 'bc1', status: 'confirmed' } });
    await insertGoogleEvent({ request } as never, 'primary', 'bc1', body);
    expect(request.mock.calls.map(([r]) => [r.method, r.url.endsWith('/events/bc1')])).toEqual([
      ['POST', false],
      ['GET', true],
      ['PUT', true],
    ]);
  });

  it('turns Google refusals into actionable messages', () => {
    expect(describeGoogleError(gaxios(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))).toMatchObject({
      status: 403,
      code: 'calendar_reconnect',
    });
    expect(describeGoogleError(new Error('invalid_grant'))).toMatchObject({ code: 'calendar_reconnect' });
    expect(describeGoogleError(gaxios(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }))).toMatchObject({
      code: 'calendar_reconnect',
    });
    expect(describeGoogleError(gaxios(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }))).toMatchObject({
      status: 503,
      code: 'calendar_unavailable',
    });
    expect(describeGoogleError(gaxios(400, { error: { message: 'Bad time range' } })).message).toContain('Bad time range');
    expect(describeGoogleError(new Error('socket hang up'))).toMatchObject({ status: 503, code: 'calendar_unavailable' });
  });
});

describe('return path after reconnecting Google', () => {
  it('only ever returns into this app', () => {
    expect(safeReturnPath('/history?id=abc')).toBe('/history?id=abc');
    for (const evil of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 42, undefined])
      expect(safeReturnPath(evil)).toBe('/');
  });
});

// ---------------------------------------------------------------------------------------
// Through the API, against a real PostgreSQL engine and a fake Google.
// ---------------------------------------------------------------------------------------

const key = 'cd'.repeat(32);
const DENTIST = 'Mets dans mon agenda dentiste mardi prochain à 15 h';

/** A tiny Google Calendar: ids are unique per calendar, like the real one. */
function fakeGoogle() {
  const events = new Map<string, Record<string, unknown>>();
  let loseNext = false;
  const request = vi.fn(async ({ url, method, data }: { url: string; method?: string; data?: Record<string, unknown> }) => {
    if (url.endsWith('/calendarList')) return { data: { items: [{ id: 'primary@example.com', accessRole: 'owner', summary: 'Julien' }] } };
    if (method === 'POST') {
      const id = String(data!.id);
      if (events.has(id)) throw Object.assign(new Error('duplicate'), { response: { status: 409, data: {} } });
      events.set(id, { ...data, status: 'confirmed', htmlLink: `https://www.google.com/calendar/event?eid=${id}` });
      if (loseNext) {
        // The event exists, but the answer is lost on the way back.
        loseNext = false;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return { data: events.get(id) };
    }
    if (method === 'GET' && /\/events\/[^/]+$/.test(url)) return { data: events.get(url.split('/').pop()!) };
    if (url.includes('/events')) return { data: { items: [] } };
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { events, request, loseNextAnswer: () => (loseNext = true) };
}

describe('capture to calendar event, end to end', () => {
  let ctx: TestContext;
  let owner: string;
  let cookie: string;
  beforeAll(async () => {
    ctx = await setup({
      calendar: { clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost:3000/api/calendar/callback', encryptionKey: key },
    });
    owner = await createUser(ctx.db, 'event@example.com');
    cookie = await login(ctx.app, 'event@example.com');
  });
  afterAll(() => ctx.close());
  afterEach(() => {
    vi.restoreAllMocks();
    ctx.ai.failEvent = false;
    ctx.ai.nextEvent = extraction();
  });

  const capture = async (text: string, extra: Record<string, unknown> = {}) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/captures',
      headers: { cookie },
      payload: { clientId: newClientId(), kind: 'text', text, ...extra },
    });
    expect(res.statusCode).toBe(201);
    return res.json().capture as { id: string; clientId: string; text: string; originalText: string };
  };
  const eventOf = async (id: string) => (await ctx.app.inject({ url: `/api/captures/${id}/event`, headers: { cookie } })).json();
  const confirm = (id: string, draft: unknown) =>
    ctx.app.inject({ method: 'POST', url: `/api/captures/${id}/event`, headers: { cookie }, payload: { draft } });
  const connect = (scopes: string) =>
    ctx.db
      .insert(calendarConnections)
      .values({ ownerId: owner, refreshToken: seal('refresh', key), grantedScopes: scopes })
      .onConflictDoUpdate({ target: calendarConnections.ownerId, set: { grantedScopes: scopes } });

  it('a note with a date but no calendar request stays a plain capture, without asking the model', async () => {
    const before = ctx.ai.eventCalls.length;
    const c = await capture('Demain, penser à regarder cette offre');
    expect(ctx.ai.eventCalls.length).toBe(before);
    expect(await eventOf(c.id)).toMatchObject({ event: null });
  });

  it('proposes the event read from the phone’s time and zone, once per capture', async () => {
    // Taken offline two days ago and sent now: dates are read from when it was said.
    const capturedAt = Date.now() - 2 * 86_400_000;
    const clientId = newClientId();
    const payload = { clientId, kind: 'text', text: DENTIST, capturedAt, timeZone: 'Asia/Ho_Chi_Minh' };
    const first = await ctx.app.inject({ method: 'POST', url: '/api/captures', headers: { cookie }, payload });
    const call = ctx.ai.eventCalls.at(-1)!;
    expect(call).toMatchObject({ text: DENTIST, timeZone: 'Asia/Ho_Chi_Minh' });
    expect(call.reference.getTime()).toBe(capturedAt);
    // A retry of the same upload: same capture, no second proposal or model call.
    const calls = ctx.ai.eventCalls.length;
    const retry = await ctx.app.inject({ method: 'POST', url: '/api/captures', headers: { cookie }, payload });
    expect(retry.statusCode).toBe(200);
    expect(ctx.ai.eventCalls.length).toBe(calls);
    const id = first.json().capture.id;
    expect(await eventOf(id)).toMatchObject({
      access: 'disconnected',
      event: {
        state: 'proposed',
        extraction: 'done',
        draft: { title: 'Dentiste', start: '2026-11-17T15:00', end: '2026-11-17T16:00', startTimeZone: 'Asia/Ho_Chi_Minh' },
      },
    });
    // The capture itself is untouched.
    expect(first.json().capture.originalText).toBe(DENTIST);
  });

  it('a voice capture carries the phone clock and zone too', async () => {
    ctx.ai.transcript = DENTIST;
    const capturedAt = Date.now() - 60_000;
    const { payload, headers } = await voicePayload(
      { clientId: newClientId(), durationMs: '4000', capturedAt: String(capturedAt), timeZone: PARIS },
      new Uint8Array([1, 2, 3]),
    );
    const res = await ctx.app.inject({ method: 'POST', url: '/api/captures/voice', headers: { ...headers, cookie }, payload });
    expect(res.statusCode).toBe(201);
    expect(ctx.ai.eventCalls.at(-1)).toMatchObject({ timeZone: PARIS, reference: new Date(capturedAt) });
    expect((await eventOf(res.json().capture.id)).event.state).toBe('proposed');
  });

  it('no card when the model reads the whole note and finds no request', async () => {
    ctx.ai.nextEvent = extraction({ isEventRequest: false });
    const c = await capture("Penser à noter dans l'agenda de l'équipe que le serveur est en panne ? Non, juste le dire à Paul.");
    expect((await eventOf(c.id)).event).toBeNull();
  });

  it('a model failure still shows a card to fill by hand, and the save itself succeeds', async () => {
    ctx.ai.failEvent = true;
    const c = await capture(DENTIST);
    expect((await eventOf(c.id)).event).toMatchObject({ extraction: 'failed', draft: { start: null } });
    ctx.ai.failEvent = false;
    const reread = await ctx.app.inject({ method: 'POST', url: `/api/captures/${c.id}/event/extract`, headers: { cookie } });
    expect(reread.json().event).toMatchObject({ extraction: 'done', draft: { start: '2026-11-17T15:00' } });
  });

  it('asks to (re)connect instead of failing silently, and never calls Google without the right', async () => {
    const google = fakeGoogle();
    vi.spyOn(OAuth2Client.prototype, 'request').mockImplementation(google.request as never);
    const c = await capture(DENTIST);
    const { draft } = (await eventOf(c.id)).event;
    const none = await confirm(c.id, draft);
    expect(none.statusCode).toBe(403);
    expect(none.json()).toMatchObject({ error: 'calendar_reconnect' });

    // The grant made for the dashboard: reading only.
    await connect('https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly');
    expect((await eventOf(c.id)).access).toBe('reconnect');
    const readOnly = await confirm(c.id, draft);
    expect(readOnly.json()).toMatchObject({ error: 'calendar_reconnect' });
    expect(google.request).not.toHaveBeenCalled();
    // The failure is kept, so reopening the capture later still shows it.
    expect((await eventOf(c.id)).event.lastError).toMatchObject({ code: 'calendar_reconnect' });
    // Meanwhile the dashboard keeps reading the calendar with that old grant.
    const day = await ctx.app.inject({ url: '/api/calendar/day', headers: { cookie } });
    expect(day.json().state).toBe('ready');
  });

  it('creates one event for a double tap, a lost answer and a later retry', async () => {
    await connect(CALENDAR_SCOPES.join(' '));
    const google = fakeGoogle();
    vi.spyOn(OAuth2Client.prototype, 'request').mockImplementation(google.request as never);
    const c = await capture(DENTIST);
    const { draft } = (await eventOf(c.id)).event;
    const edited = { ...draft, location: 'Cabinet du Dr Martin' };

    // Google stores the event but the answer never comes back.
    google.loseNextAnswer();
    const lost = await confirm(c.id, edited);
    expect(lost.statusCode).toBe(503);
    expect(lost.json()).toMatchObject({ error: 'calendar_unavailable' });
    expect(google.events.size).toBe(1);

    // Double tap on "Réessayer": two requests at once.
    const [a, b] = await Promise.all([confirm(c.id, edited), confirm(c.id, edited)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(google.events.size).toBe(1);
    const created = a.json().event;
    expect(created).toMatchObject({ state: 'created', lastError: null, draft: { location: 'Cabinet du Dr Martin' } });
    expect(created.eventUrl).toMatch(/^https:\/\/www\.google\.com\/calendar\/event/);

    // Once created, a further tap does not even reach Google.
    const calls = google.request.mock.calls.length;
    expect((await confirm(c.id, edited)).json().event.state).toBe('created');
    expect(google.request.mock.calls.length).toBe(calls);

    const [stored] = [...google.events.values()];
    expect(stored).toMatchObject({
      id: googleEventId(c.id),
      summary: 'Dentiste',
      location: 'Cabinet du Dr Martin',
      description: DENTIST,
      start: { dateTime: '2026-11-17T15:00:00', timeZone: PARIS },
      end: { dateTime: '2026-11-17T16:00:00', timeZone: PARIS },
    });
    const [row] = await ctx.db.select().from(captureEvents).where(eq(captureEvents.captureId, c.id));
    expect(row).toMatchObject({ state: 'created', calendarId: 'primary', googleEventId: googleEventId(c.id) });
  });

  it('an expired Google token surfaces as "reconnect", and reconnecting clears it', async () => {
    await connect(CALENDAR_SCOPES.join(' '));
    const google = fakeGoogle();
    vi.spyOn(OAuth2Client.prototype, 'request').mockImplementation(async () => {
      throw Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
    });
    const c = await capture(DENTIST);
    const { draft } = (await eventOf(c.id)).event;
    const res = await confirm(c.id, draft);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'calendar_reconnect', message: expect.stringContaining('Reconnecte') });
    expect(google.events.size).toBe(0);

    // Reconnect from the capture: Google's consent screen brings the browser back to it.
    vi.restoreAllMocks();
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { refresh_token: 'new-refresh', scope: CALENDAR_SCOPES.join(' ') },
      res: null,
    } as never);
    const start = await ctx.app.inject({
      method: 'POST',
      url: '/api/calendar/connect',
      headers: { cookie },
      payload: { returnTo: `/history?id=${c.id}` },
    });
    const state = new URL(start.json().url).searchParams.get('state');
    const stateCookie = start.cookies.find((x) => x.name === 'bc_calendar_state')!;
    const back = await ctx.app.inject({
      url: `/api/calendar/callback?state=${state}&code=test`,
      headers: { cookie: `${cookie}; bc_calendar_state=${stateCookie.value}` },
    });
    expect(back.headers.location).toBe(`/history?id=${c.id}&calendar=connected`);
    expect((await eventOf(c.id)).event.lastError).toBeNull();
  });

  it('rejects an invalid draft before calling Google and lets a proposal be dismissed', async () => {
    await connect(CALENDAR_SCOPES.join(' '));
    const google = fakeGoogle();
    vi.spyOn(OAuth2Client.prototype, 'request').mockImplementation(google.request as never);
    const c = await capture(DENTIST);
    const { draft } = (await eventOf(c.id)).event;
    const bad = await confirm(c.id, { ...draft, end: '2026-11-17T14:00' });
    expect(bad.statusCode).toBe(400);
    expect(google.request).not.toHaveBeenCalled();
    const dismissed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/captures/${c.id}/event`,
      headers: { cookie },
      payload: { state: 'dismissed' },
    });
    expect(dismissed.json().event.state).toBe('dismissed');
  });

  it('keeps proposals private to their owner', async () => {
    const c = await capture(DENTIST);
    await createUser(ctx.db, 'intruder@example.com');
    const intruder = await login(ctx.app, 'intruder@example.com');
    const peek = await ctx.app.inject({ url: `/api/captures/${c.id}/event`, headers: { cookie: intruder } });
    expect(peek.json().event).toBeNull();
    const write = await ctx.app.inject({
      method: 'POST',
      url: `/api/captures/${c.id}/event`,
      headers: { cookie: intruder },
      payload: { draft: (await eventOf(c.id)).event.draft },
    });
    expect(write.statusCode).toBe(404);
  });
});

describe('dashboard read access', () => {
  it('accepts the old read-only grant and the new read-write one', () => {
    const list = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
    expect(canReadCalendars(`https://www.googleapis.com/auth/calendar.events.readonly ${list}`)).toBe(true);
    expect(canReadCalendars(CALENDAR_SCOPES.join(' '))).toBe(true);
    expect(canReadCalendars('https://www.googleapis.com/auth/calendar.events.readonly')).toBe(false);
    expect(canReadCalendars('')).toBe(false);
  });
});
