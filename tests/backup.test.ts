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

async function capture(text: string, as = cookie): Promise<Capture> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/captures', headers: { cookie: as }, payload: { clientId: newClientId(), kind: 'text', text } });
  return res.json().capture;
}

async function exportAs(as = cookie) {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/export', headers: { cookie: as } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function importAs(payload: unknown, as = cookie) {
  return ctx.app.inject({ method: 'POST', url: '/api/import', headers: { cookie: as }, payload: payload as object });
}

describe('export', () => {
  it('contains every capture of the owner with all user-visible fields, and nothing of others', async () => {
    const a = await capture('First idea');
    await ctx.app.inject({ method: 'PATCH', url: `/api/captures/${a.id}`, headers: { cookie }, payload: { status: 'done', text: 'First idea, edited', title: 'Renamed' } });
    await capture('Second idea');
    await createUser(ctx.db, 'intruder@example.com');
    const other = await login(ctx.app, 'intruder@example.com');
    await capture('Not mine', other);

    const file = await exportAs();
    expect(file).toMatchObject({ format: 'brain-capture-export', version: 1 });
    expect(file.captures.map((c: { text: string }) => c.text)).toEqual(['First idea, edited', 'Second idea']);
    expect(file.captures[0]).toMatchObject({ originalText: 'First idea', title: 'Renamed', titleManual: true, status: 'done' });
    expect(file.captures[0].doneAt).not.toBeNull();
  });

  it('is private', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/export' });
    expect(res.statusCode).toBe(401);
  });

  it('can be downloaded as a file', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/export?download=1', headers: { cookie } });
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="brain-capture-.*\.json"$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('restore', () => {
  it('a backup restored into an empty database exports identically', async () => {
    await capture('Idea one');
    const two = await capture('Idea two');
    await ctx.app.inject({ method: 'PATCH', url: `/api/captures/${two.id}`, headers: { cookie }, payload: { category: 'learning' } });
    const original = await exportAs();

    // A brand-new, isolated database with its own owner account.
    const fresh = await setup();
    try {
      await createUser(fresh.db, 'julien@example.com');
      const freshCookie = await login(fresh.app, 'julien@example.com');
      const res = await fresh.app.inject({ method: 'POST', url: '/api/import', headers: { cookie: freshCookie }, payload: original });
      expect(res.json()).toEqual({ inserted: 2, skipped: 0, deleted: 0, total: 2 });
      const restored = (await fresh.app.inject({ method: 'GET', url: '/api/export', headers: { cookie: freshCookie } })).json();
      expect(restored.captures).toEqual(original.captures);
    } finally {
      await fresh.close();
    }
  });

  it('restores anything the app could store, such as a long percent-encoded URL', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/captures',
      headers: { cookie },
      payload: { clientId: newClientId(), kind: 'link', url: `https://example.com/${'é'.repeat(1000)}` },
    });
    expect(res.statusCode).toBe(201);
    const original = await exportAs();
    expect(original.captures[0].url.length).toBeGreaterThan(4096);

    const fresh = await setup();
    try {
      await createUser(fresh.db, 'julien@example.com');
      const freshCookie = await login(fresh.app, 'julien@example.com');
      const imported = await fresh.app.inject({ method: 'POST', url: '/api/import', headers: { cookie: freshCookie }, payload: original });
      expect(imported.json()).toEqual({ inserted: 1, skipped: 0, deleted: 0, total: 1 });
      const restored = (await fresh.app.inject({ method: 'GET', url: '/api/export', headers: { cookie: freshCookie } })).json();
      expect(restored.captures).toEqual(original.captures);
    } finally {
      await fresh.close();
    }
  });

  it('is idempotent and never overwrites a capture that already exists', async () => {
    const a = await capture('Kept as is');
    const backup = await exportAs();
    await ctx.app.inject({ method: 'PATCH', url: `/api/captures/${a.id}`, headers: { cookie }, payload: { text: 'Changed after the backup' } });

    const res = await importAs(backup);
    expect(res.json()).toEqual({ inserted: 0, skipped: 1, deleted: 0, total: 1 });
    const [row] = await ctx.db.select().from(captures).where(eq(captures.id, a.id));
    expect(row!.text).toBe('Changed after the backup');
  });

  it('brings back a capture lost since the backup (gone from the database, not deleted in the app)', async () => {
    const a = await capture('Lost then restored');
    const backup = await exportAs();
    await ctx.db.delete(captures).where(eq(captures.id, a.id));
    expect((await importAs(backup)).json()).toEqual({ inserted: 1, skipped: 0, deleted: 0, total: 1 });
    expect((await exportAs()).captures).toEqual(backup.captures);
  });

  it('cannot take over or reveal another account capture with a forged id', async () => {
    const theirs = await (async () => {
      await createUser(ctx.db, 'intruder@example.com');
      const other = await login(ctx.app, 'intruder@example.com');
      return capture('Their private note', other);
    })();
    const forged = {
      format: 'brain-capture-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      captures: [{ ...(await exportAs()).captures[0], ...{ id: theirs.id, clientId: newClientId(), text: 'x', originalText: 'x', title: null, titleManual: false, url: null, category: 'other', categorySource: 'fallback', classificationStatus: 'done', status: 'open', durationMs: null, device: null, kind: 'text', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), doneAt: null, archivedAt: null } }],
    };
    expect((await importAs(forged)).json()).toEqual({ inserted: 0, skipped: 1, deleted: 0, total: 1 });
    const [row] = await ctx.db.select().from(captures).where(eq(captures.id, theirs.id));
    expect(row!.text).toBe('Their private note');
    expect((await exportAs()).captures).toHaveLength(0);
  });

  it('refuses anything that is not a backup file, and anonymous imports', async () => {
    expect((await importAs({ hello: 'world' })).statusCode).toBe(400);
    expect((await importAs({ format: 'brain-capture-export', version: 2, exportedAt: new Date().toISOString(), captures: [] })).statusCode).toBe(400);
    const anon = await ctx.app.inject({ method: 'POST', url: '/api/import', payload: { format: 'brain-capture-export', version: 1, exportedAt: new Date().toISOString(), captures: [] } });
    expect(anon.statusCode).toBe(401);
  });
});
