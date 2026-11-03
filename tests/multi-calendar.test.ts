import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { eq } from 'drizzle-orm';
import { CALENDAR_SCOPES, listCalendars, readCalendarDay, seal } from '../src/server/dashboard/calendar.js';
import { dayWindow } from '../src/server/dashboard/day.js';
import { calendarConnections } from '../src/server/db/schema.js';
import { dayRhythm } from '../src/web/screens/Today.js';
import { createUser, login, setup, type TestContext } from './helpers.js';

// The availability helper deliberately uses the browser's local zone.
process.env.TZ = 'Europe/Paris';
const key = 'ab'.repeat(32);
const window = dayWindow('Europe/Paris', new Date('2026-11-03T12:00:00Z'));
const calendars = [
  { id: 'lifestyle', summary: 'Lifestyle', accessRole: 'owner', backgroundColor: '#4986e7' },
  { id: 'education', summary: 'Education', accessRole: 'owner', backgroundColor: '#fa573c' },
  { id: 'business', summary: 'Business', accessRole: 'owner', backgroundColor: '#fad165' },
  { id: 'health', summary: 'Health & Fitness', accessRole: 'owner', backgroundColor: '#7bd148' },
  { id: 'holidays', summary: 'Holidays', accessRole: 'reader', backgroundColor: '#16a765' },
];
const event = (id: string, title: string, start: string, end: string, extra = {}) => ({
  id,
  summary: title,
  start: { dateTime: `2026-11-03T${start}:00+01:00` },
  end: { dateTime: `2026-11-03T${end}:00+01:00` },
  ...extra,
});
const entries: Record<string, unknown[]> = {
  lifestyle: [event('same-id', 'Radar Emploi', '15:15', '17:15')],
  education: [
    event('same-id', 'Building with Claude API', '08:30', '10:15'),
    event('learn', 'Learn By Doing', '10:30', '12:15'),
  ],
  business: [event('business', 'Automata Things', '13:30', '15:00')],
  health: [],
  holidays: [event('holiday', 'Holiday', '08:00', '20:00')],
};
function transport(failed?: string) {
  return vi.fn(async ({ url }: { url: string }) => {
    if (url.endsWith('/calendarList')) return { data: { items: calendars } };
    const id = decodeURIComponent(url.match(/calendars\/(.+)\/events/)?.[1] ?? '');
    if (id === failed) throw new Error('source unavailable');
    if (!(id in entries)) throw new Error('Unexpected calendar');
    return { data: { items: entries[id] } };
  });
}
const client = (request: ReturnType<typeof transport>) => ({ request }) as unknown as OAuth2Client;

describe('complete multi-calendar day', () => {
  it('includes all four owned calendars, keeps source identity, orders events and excludes subscriptions by default', async () => {
    const request = transport();
    const day = await readCalendarDay(client(request), window, null);
    expect(day.state).toBe('ready');
    expect(
      day.calendars
        ?.filter((c) => c.selected)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['Business', 'Education', 'Health & Fitness', 'Lifestyle']);
    expect(day.events.map((e) => e.title)).toEqual([
      'Building with Claude API',
      'Learn By Doing',
      'Automata Things',
      'Radar Emploi',
    ]);
    expect(day.events[0]).toMatchObject({ calendarName: 'Education', calendarColor: '#fa573c' });
    expect(new Set(day.events.map((e) => e.id)).size).toBe(4); // Same provider id on different calendars remains distinct.
    expect(request.mock.calls.some(([r]) => r.url.includes('/holidays/events'))).toBe(false);
    expect(dayRhythm(day.events, '2026-11-03').freeMinutes).toBe(300);
  });
  it('honours an explicit selection, including deliberate deselection of everything', async () => {
    const request = transport();
    const onlyBusiness = await readCalendarDay(client(request), window, ['business']);
    expect(onlyBusiness.events.map((e) => e.title)).toEqual(['Automata Things']);
    const none = await readCalendarDay(client(request), window, []);
    expect(none.state).toBe('ready');
    expect(none.events).toEqual([]);
    expect(none.calendars?.some((c) => c.selected)).toBe(false);
  });
  it('reports partial failure and inaccessible selections rather than inventing free time', async () => {
    const partial = await readCalendarDay(client(transport('education')), window, null);
    expect(partial.state).toBe('partial');
    expect(partial.events).toHaveLength(2);
    expect(partial.calendars?.find((c) => c.id === 'education')).toMatchObject({ selected: true, loadState: 'error' });
    const gone = await readCalendarDay(client(transport()), window, ['deleted-calendar']);
    expect(gone).toMatchObject({ state: 'partial', missingCalendarCount: 1 });
  });
  it('does not silently treat a failed discovery as an empty successful day', async () => {
    await expect(
      readCalendarDay(
        { request: vi.fn().mockRejectedValue(new Error('403')) } as unknown as OAuth2Client,
        window,
        null,
      ),
    ).rejects.toThrow();
  });
  it('merges overlaps across calendars and preserves all-day/transparent semantics', () => {
    const base = {
      id: 'a',
      title: 'A',
      start: '2026-11-03T09:00:00+01:00',
      end: '2026-11-03T11:00:00+01:00',
      allDay: false,
      busy: true,
      url: null,
    };
    const overlap = { ...base, id: 'b', start: '2026-11-03T10:00:00+01:00', end: '2026-11-03T12:00:00+01:00' };
    expect(dayRhythm([base, overlap], '2026-11-03').freeMinutes).toBe(540);
    const full = { ...base, id: 'full', allDay: true, start: '2026-11-03', end: '2026-11-04' };
    expect(dayRhythm([full, base], '2026-11-03').freeMinutes).toBe(0);
    expect(dayRhythm([{ ...full, busy: false }, base], '2026-11-03').freeMinutes).toBe(600);
  });
  it('discovers all pages, filters deleted/unreadable entries and validates colours', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [calendars[0]], nextPageToken: 'next' } })
      .mockResolvedValueOnce({
        data: {
          items: [
            { ...calendars[1], backgroundColor: 'url(invalid)', summaryOverride: 'Study' },
            { id: 'gone', accessRole: 'owner', deleted: true },
            { id: 'busy', accessRole: 'freeBusyReader' },
            { id: 'hidden', accessRole: 'owner', hidden: true },
          ],
        },
      });
    const all = await listCalendars({ request } as unknown as OAuth2Client);
    expect(all).toHaveLength(3);
    expect(all.find((c) => c.id === 'education')).toMatchObject({ name: 'Study', color: '#ffad52' });
    expect(request.mock.calls[1]![0].params.pageToken).toBe('next');
    const day = await readCalendarDay(
      {
        request: vi.fn(async ({ url }) =>
          url.endsWith('/calendarList')
            ? { data: { items: [{ id: 'hidden', accessRole: 'owner', hidden: true }] } }
            : { data: { items: [] } },
        ),
      } as unknown as OAuth2Client,
      window,
      null,
    );
    expect(day.calendars?.some((c) => c.selected)).toBe(false);
  });
});

describe('calendar permission and preference persistence', () => {
  let ctx: TestContext;
  let owner: string;
  let cookie: string;
  let otherCookie: string;
  beforeAll(async () => {
    ctx = await setup({
      calendar: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'http://localhost:3000/api/calendar/callback',
        encryptionKey: key,
      },
    });
    owner = await createUser(ctx.db, 'calendar@example.com');
    await createUser(ctx.db, 'other-calendar@example.com');
    cookie = await login(ctx.app, 'calendar@example.com');
    otherCookie = await login(ctx.app, 'other-calendar@example.com');
    await ctx.db.insert(calendarConnections).values({ ownerId: owner, refreshToken: seal('private-token', key) });
  });
  afterAll(() => ctx.close());
  it('requires renewed permission for legacy grants without deleting their encrypted token', async () => {
    const spy = vi.spyOn(OAuth2Client.prototype, 'request');
    try {
      const day = await ctx.app.inject({ url: '/api/calendar/day', headers: { cookie } });
      expect(day.json()).toMatchObject({ state: 'permission_required', events: [] });
      expect(spy).not.toHaveBeenCalled();
      const [stored] = await ctx.db.select().from(calendarConnections).where(eq(calendarConnections.ownerId, owner));
      expect(stored?.refreshToken).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
  it('persists only accessible calendar IDs per owner, and reset restores automatic ownership selection', async () => {
    await ctx.db
      .update(calendarConnections)
      .set({ grantedScopes: CALENDAR_SCOPES.join(' ') })
      .where(eq(calendarConnections.ownerId, owner));
    const spy = vi.spyOn(OAuth2Client.prototype, 'request').mockImplementation(transport() as never);
    const save = (calendarIds: string[] | null, as = cookie) =>
      ctx.app.inject({
        method: 'PATCH',
        url: '/api/calendar/selection',
        headers: { cookie: as },
        payload: { calendarIds },
      });
    try {
      expect((await save(['business'])).statusCode).toBe(200);
      expect((await ctx.app.inject({ url: '/api/calendar/day', headers: { cookie } })).json().events).toHaveLength(1);
      expect((await save(['unknown'])).statusCode).toBe(400);
      expect((await save(['education'], otherCookie)).statusCode).toBe(400);
      const [row] = await ctx.db.select().from(calendarConnections).where(eq(calendarConnections.ownerId, owner));
      expect(row?.calendarIds).toEqual(['business']);
      expect((await save([])).statusCode).toBe(200);
      expect((await ctx.app.inject({ url: '/api/calendar/day', headers: { cookie } })).json().events).toEqual([]);
      expect((await save(null)).statusCode).toBe(200);
      const day = (await ctx.app.inject({ url: '/api/calendar/day', headers: { cookie } })).json();
      expect(day.events).toHaveLength(4);
      expect(day.calendars.filter((c: { selected: boolean }) => c.selected)).toHaveLength(4);
      const backup = (await ctx.app.inject({ url: '/api/export', headers: { cookie } })).body;
      expect(backup).not.toContain('private-token');
      expect(backup).not.toContain('calendarIds');
    } finally {
      spy.mockRestore();
    }
  });
});
