import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { eq } from 'drizzle-orm';
import { dayWindow } from '../src/server/dashboard/day.js';
import { calendarEvents, seal, unseal } from '../src/server/dashboard/calendar.js';
import { radarPayload } from '../src/server/dashboard/radars.js';
import { calendarConnections, captures } from '../src/server/db/schema.js';
import { loadConfig } from '../src/server/config.js';
import { createUser, login, newClientId, setup, type TestContext } from './helpers.js';

describe('local calendar days', () => {
  it('uses yesterday in the chosen zone and handles 23/25 hour days', () => {
    const spring = dayWindow('Europe/Paris', new Date('2026-03-29T12:00:00Z'));
    expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(23 * 3600_000);
    const fall = dayWindow('Europe/Paris', new Date('2026-10-25T12:00:00Z'));
    expect(Date.parse(fall.end) - Date.parse(fall.start)).toBe(25 * 3600_000);
    const asia = dayWindow('Asia/Ho_Chi_Minh', new Date('2026-11-03T00:30:00Z'));
    expect(asia.date).toBe('2026-11-03');
    expect(asia.previousStart).toBe('2026-11-01T17:00:00.000Z');
  });
});

describe('projects and dashboard ownership', () => {
  let ctx: TestContext;
  let cookie: string;
  let other: string;
  beforeAll(async () => {
    ctx = await setup();
    await createUser(ctx.db, 'owner@example.com');
    await createUser(ctx.db, 'other@example.com');
    cookie = await login(ctx.app, 'owner@example.com');
    other = await login(ctx.app, 'other@example.com');
  });
  afterAll(() => ctx.close());
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, as = cookie) =>
    ctx.app.inject({ method, url, headers: { cookie: as }, payload });

  it('requires authentication and validates project states', async () => {
    expect((await ctx.app.inject({ url: '/api/today' })).statusCode).toBe(401);
    expect((await call('POST', '/api/projects', { name: 'bad', state: 'arbitrary' })).statusCode).toBe(400);
    expect((await call('GET', '/api/today?timeZone=nowhere')).statusCode).toBe(400);
  });
  it('creates a project from a capture atomically, supports states and protects other owners', async () => {
    const note = (
      await call('POST', '/api/captures', { kind: 'text', text: 'A small product', clientId: newClientId() })
    ).json().capture;
    const response = await call('POST', '/api/projects', { name: 'Product', captureId: note.id });
    expect(response.statusCode).toBe(201);
    const { id } = response.json();
    expect((await call('GET', `/api/projects/${id}/captures`)).json().captures[0].id).toBe(note.id);
    expect((await call('GET', `/api/captures/${note.id}/projects`)).json().projectIds).toEqual([id]);
    expect(
      (await call('PATCH', `/api/projects/${id}`, { state: 'active', nextStep: 'Build one useful screen' })).statusCode,
    ).toBe(200);
    expect((await call('PATCH', `/api/projects/${id}`, { name: 'stolen' }, other)).statusCode).toBe(404);
    expect((await call('GET', `/api/projects/${id}/captures`, undefined, other)).statusCode).toBe(404);
    expect((await call('PUT', `/api/projects/${id}/captures/${note.id}`, undefined, other)).statusCode).toBe(404);
    const foreign = (
      await call('POST', '/api/captures', { kind: 'text', text: 'Private', clientId: newClientId() }, other)
    ).json().capture;
    expect((await call('PUT', `/api/projects/${id}/captures/${foreign.id}`)).statusCode).toBe(404);
    expect((await call('POST', '/api/projects', { name: 'Cross owner', captureId: foreign.id })).statusCode).toBe(404);
    expect((await call('GET', '/api/projects')).json().projects).toHaveLength(1);
    expect((await call('PUT', `/api/projects/${id}/captures/${note.id}`)).statusCode).toBe(200);
    expect((await call('GET', '/api/projects')).json().projects[0]).toMatchObject({ state: 'active', captureCount: 1 });
    expect((await call('DELETE', `/api/projects/${id}/captures/${note.id}`)).statusCode).toBe(200);
    expect((await call('GET', `/api/captures/${note.id}`)).statusCode).toBe(200);
  });
  it('backs up projects and their links, restores idempotently and keeps old files valid', async () => {
    const note = (
      await call('POST', '/api/captures', { kind: 'text', text: 'Backup link', clientId: newClientId() })
    ).json().capture;
    await call('POST', '/api/projects', { name: 'Backup project', state: 'upcoming', captureId: note.id });
    const backup = (await call('GET', '/api/export')).json();
    expect(backup.projects.length).toBeGreaterThan(0);
    expect(backup.projectLinks).toHaveLength(1);
    expect(JSON.stringify(backup)).not.toContain('refreshToken');
    const target = await setup();
    try {
      await createUser(target.db, 'restore@example.com');
      const targetCookie = await login(target.app, 'restore@example.com');
      for (let n = 0; n < 2; n++)
        expect(
          (
            await target.app.inject({
              method: 'POST',
              url: '/api/import',
              headers: { cookie: targetCookie },
              payload: backup,
            })
          ).statusCode,
        ).toBe(200);
      const restored = (await target.app.inject({ url: '/api/export', headers: { cookie: targetCookie } })).json();
      expect(restored.projects).toEqual(backup.projects);
      expect(restored.projectLinks).toEqual(backup.projectLinks);
      expect(restored.captures).toEqual(backup.captures);
      // Importing someone else's IDs into the existing DB must not create cross-owner links.
      expect((await call('POST', '/api/import', backup, other)).statusCode).toBe(200);
      expect((await call('GET', '/api/projects', undefined, other)).json().projects).toEqual([]);
    } finally {
      await target.close();
    }
    const { projects: _p, projectLinks: _l, ...legacy } = backup;
    expect((await call('POST', '/api/import', legacy)).statusCode).toBe(200);
  });
  it('selects the previous local day, including finished notes, with owner isolation', async () => {
    const window = dayWindow('Europe/Paris');
    const id = (
      await call('POST', '/api/captures', { kind: 'text', text: 'Yesterday', clientId: newClientId() })
    ).json().capture.id;
    await ctx.db
      .update(captures)
      .set({ createdAt: new Date(Date.parse(window.previousStart) + 1000), status: 'done' })
      .where(eq(captures.id, id));
    const data = (await call('GET', '/api/today?timeZone=Europe%2FParis')).json();
    expect(data.yesterday.count).toBe(1);
    expect(data.yesterday.captures[0]).toMatchObject({ id, status: 'done' });
    expect(data.projects.length).toBeGreaterThan(0);
  });
  it('shows unconfigured integrations explicitly, never invented zeroes', async () => {
    expect((await call('GET', '/api/radars')).json().jobs).toMatchObject({ state: 'unconfigured', total: null });
    expect((await call('GET', '/api/calendar/day')).json()).toMatchObject({ state: 'unconfigured', events: [] });
  });
});

describe('calendar security and event reading', () => {
  const key = 'a1'.repeat(32);
  it('authenticates encrypted tokens and rejects altered ciphertext', () => {
    const encrypted = seal('private-refresh-token', key);
    expect(encrypted).not.toContain('private-refresh-token');
    expect(unseal(encrypted, key)).toBe('private-refresh-token');
    expect(() => unseal(encrypted, 'a2'.repeat(32))).toThrow();
  });
  it('expands recurring events, follows pagination, ignores cancelled and declined events', async () => {
    const event = (id: string) => ({
      id,
      summary: id,
      start: { dateTime: '2026-11-03T09:00:00+01:00' },
      end: { dateTime: '2026-11-03T10:00:00+01:00' },
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [event('one'), { ...event('cancelled'), status: 'cancelled' }], nextPageToken: 'next' },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            { ...event('declined'), attendees: [{ self: true, responseStatus: 'declined' }] },
            {
              ...event('day'),
              start: { date: '2026-11-03' },
              end: { date: '2026-11-04' },
              transparency: 'transparent',
            },
          ],
        },
      });
    const events = await calendarEvents(
      { request } as unknown as OAuth2Client,
      dayWindow('Europe/Paris', new Date('2026-11-03T12:00:00Z')),
      'primary',
    );
    expect(events.map((e) => e.id)).toEqual(['one', 'day']);
    expect(events[1]).toMatchObject({ allDay: true, busy: false });
    expect(request.mock.calls[0]![0].params).toMatchObject({ singleEvents: true, timeZone: 'Europe/Paris' });
    expect(request.mock.calls[1]![0].params.pageToken).toBe('next');
  });
  it('binds OAuth callbacks to state and owner; exports never contain OAuth tokens', async () => {
    const ctx = await setup({
      calendar: {
        clientId: 'client',
        clientSecret: 'private',
        redirectUri: 'http://localhost:3000/api/calendar/callback',
        encryptionKey: key,
        calendarId: 'primary',
      },
    });
    const spy = vi
      .spyOn(OAuth2Client.prototype, 'getToken')
      .mockResolvedValue({
        tokens: { refresh_token: 'secret-refresh', scope: 'https://www.googleapis.com/auth/calendar.events.readonly' },
        res: null,
      } as never);
    try {
      await createUser(ctx.db, 'oauth@example.com');
      const cookie = await login(ctx.app, 'oauth@example.com');
      const start = await ctx.app.inject({ method: 'POST', url: '/api/calendar/connect', headers: { cookie } });
      const authUrl = new URL(start.json().url);
      expect(authUrl.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events.readonly');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      const stateCookie = start.cookies.find((c) => c.name === 'bc_calendar_state')!;
      const headers = { cookie: `${cookie}; bc_calendar_state=${stateCookie.value}` };
      const bad = await ctx.app.inject({ url: '/api/calendar/callback?state=wrong&code=test', headers });
      expect(bad.headers.location).toBe('/?calendar=failed');
      expect(spy).not.toHaveBeenCalled();
      const success = await ctx.app.inject({
        url: `/api/calendar/callback?state=${authUrl.searchParams.get('state')}&code=test`,
        headers,
      });
      expect(success.headers.location).toBe('/?calendar=connected');
      const [stored] = await ctx.db.select().from(calendarConnections);
      expect(stored!.refreshToken).not.toContain('secret-refresh');
      expect((await ctx.app.inject({ url: '/api/export', headers: { cookie } })).body).not.toContain('secret-refresh');
      await ctx.app.inject({ method: 'DELETE', url: '/api/calendar/connection', headers: { cookie } });
      expect(await ctx.db.select().from(calendarConnections)).toEqual([]);
    } finally {
      spy.mockRestore();
      await ctx.close();
    }
  });
  it('rejects incomplete configuration and inconsistent radar totals', () => {
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: 'alone' })).toThrow();
    expect(
      radarPayload.safeParse({
        version: 1,
        checkedAt: new Date().toISOString(),
        total: 5,
        new24h: 1,
        segments: [{ key: 'a', label: 'A', value: 4 }],
        extra: [],
      }).success,
    ).toBe(false);
  });
});
