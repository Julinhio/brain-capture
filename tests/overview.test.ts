import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { captures } from '../src/server/db/schema.js';
import type { Capture } from '../src/shared/types.js';
import { createUser, login, newClientId, setup, type TestContext } from './helpers.js';

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await setup();
  await createUser(ctx.db, 'julien@example.com');
  cookie = await login(ctx.app, 'julien@example.com');
});
afterEach(() => ctx.close());

async function capture(text: string, category: Capture['category'], as = cookie): Promise<Capture> {
  ctx.ai.nextClassification = { category, title: text };
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/captures',
    headers: { cookie: as },
    payload: { clientId: newClientId(), kind: 'text', text },
  });
  return res.json().capture;
}

describe('overview', () => {
  it('counts open captures per category and previews the latest three', async () => {
    for (let i = 0; i < 4; i++) await capture(`Job ${i}`, 'jobs');
    await capture('Course', 'learning');
    const done = await capture('Finished task', 'lifestyle');
    await ctx.app.inject({ method: 'PATCH', url: `/api/captures/${done.id}`, headers: { cookie }, payload: { status: 'done' } });
    // An old capture does not count as recent.
    const old = await capture('Old idea', 'projects');
    await ctx.db.update(captures).set({ createdAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(captures.id, old.id));

    const res = await ctx.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    const body = res.json();
    expect(body.counts).toEqual({ jobs: 4, automata: 0, projects: 1, learning: 1, lifestyle: 0, other: 0 });
    expect(body.done).toBe(1);
    expect(body.archived).toBe(0);
    expect(body.recent).toBe(5);
    expect(body.sections.jobs.map((c: Capture) => c.title)).toEqual(['Job 3', 'Job 2', 'Job 1']);
    expect(body.sections.lifestyle).toEqual([]);
  });

  it('only counts my own captures', async () => {
    await capture('Mine', 'jobs');
    await createUser(ctx.db, 'intruder@example.com');
    const other = await login(ctx.app, 'intruder@example.com');
    await capture('Theirs', 'jobs', other);
    const body = (await ctx.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).json();
    expect(body.counts.jobs).toBe(1);
    expect(body.sections.jobs.map((c: Capture) => c.title)).toEqual(['Mine']);
  });
});

describe('search', () => {
  it('matches title, text and URL, case-insensitively, without wildcard injection', async () => {
    await capture('Automation Lead at Qonto', 'jobs');
    await capture('Padel on Saturday', 'lifestyle');
    await capture('100% remote role', 'jobs');
    const search = async (q: string) =>
      (await ctx.app.inject({ method: 'GET', url: `/api/captures?q=${encodeURIComponent(q)}`, headers: { cookie } }))
        .json()
        .captures.map((c: Capture) => c.title);
    expect(await search('qonto')).toEqual(['Automation Lead at Qonto']);
    expect(await search('%')).toEqual(['100% remote role']);
    expect(await search('_')).toEqual([]);
  });
});
