import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../src/server/db/schema.js';
import { captures, categories } from '../src/server/db/schema.js';
import { categoryIdFor, DEFAULT_CATEGORIES } from '../src/shared/categories.js';
import { createUser, login, newClientId, setup, type TestContext } from './helpers.js';

const seeded = (rows: { id: string; name: string; description: string; color: string | null; position: number }[]) =>
  rows
    .map(({ id, name, description, color, position }) => ({ id, name, description, color, position }))
    .sort((a, b) => a.position - b.position);

describe('migration to editable categories', () => {
  it('keeps every existing capture where it was and seeds the starting list, also for later accounts', async () => {
    // A database as production has it today: migrated up to 0003, with captures in each category.
    const before = mkdtempSync(path.join(tmpdir(), 'bc-migrations-'));
    try {
      cpSync(path.resolve('drizzle'), before, { recursive: true });
      const journalPath = path.join(before, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
      journal.entries = journal.entries.filter((e) => e.tag < '0004');
      writeFileSync(journalPath, JSON.stringify(journal));

      const client = new PGlite();
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: before });
      const [user] = (await client.query<{ id: string }>(`insert into users (email, password_hash) values ('old@example.com', 'x') returning id`)).rows;
      const old = ['jobs', 'automata', 'projects', 'learning', 'lifestyle', 'other'];
      for (const [i, category] of old.entries()) {
        await client.query(
          `insert into captures (owner_id, client_id, kind, text, original_text, category, category_source, classification_status, status)
           values ($1, gen_random_uuid(), 'text', $2, $2, $3, 'auto', 'done', $4)`,
          [user!.id, `note ${i}`, category, i === 5 ? 'archived' : 'open'],
        );
      }

      await migrate(db, { migrationsFolder: path.resolve('drizzle') });

      const rows = await db.select().from(captures).where(eq(captures.ownerId, user!.id));
      expect(rows.map((r) => r.category).sort()).toEqual([...old].sort());
      expect(seeded(await db.select().from(categories).where(eq(categories.ownerId, user!.id)))).toEqual(seeded([...DEFAULT_CATEGORIES]));
      // Every capture points at an existing category, and the database keeps it that way.
      await expect(
        client.query(
          `insert into captures (owner_id, client_id, kind, text, original_text, category) values ($1, gen_random_uuid(), 'text', 'x', 'x', 'nope')`,
          [user!.id],
        ),
      ).rejects.toThrow();
      // An account created after the migration gets the same list.
      const [later] = (await client.query<{ id: string }>(`insert into users (email, password_hash) values ('new@example.com', 'x') returning id`)).rows;
      expect(seeded(await db.select().from(categories).where(eq(categories.ownerId, later!.id)))).toEqual(seeded([...DEFAULT_CATEGORIES]));
      await client.close();
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});

describe('category ids', () => {
  it('come from the name, unique, and never take a word the app already uses', () => {
    expect(categoryIdFor('Santé & sport', [])).toBe('sante-sport');
    expect(categoryIdFor('Santé & sport', ['sante-sport'])).toBe('sante-sport-2');
    expect(categoryIdFor('Done', [])).toBe('done-2');
    expect(categoryIdFor('Other', [])).toBe('other-2');
    expect(categoryIdFor('🎯', [])).toBe('category');
  });
});

describe('managing categories', () => {
  let ctx: TestContext;
  let owner: string;
  let cookie: string;
  beforeAll(async () => {
    ctx = await setup();
    owner = await createUser(ctx.db, 'categories@example.com');
    cookie = await login(ctx.app, 'categories@example.com');
  });
  afterAll(() => ctx.close());

  const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, as = cookie) =>
    ctx.app.inject({ method, url, headers: { cookie: as }, ...(payload === undefined ? {} : { payload }) });
  const capture = async (text: string) => {
    const res = await api('POST', '/api/captures', { clientId: newClientId(), kind: 'text', text });
    expect(res.statusCode).toBe(201);
    return res.json().capture as { id: string; category: string };
  };
  const list = async () => (await api('GET', '/api/categories')).json().categories as { id: string; name: string; description: string }[];

  it('starts with the five categories plus Other, Other last', async () => {
    expect((await list()).map((c) => c.id)).toEqual(['jobs', 'automata', 'projects', 'learning', 'lifestyle', 'other']);
  });

  it('a new category is offered to the sorting with its description, and used', async () => {
    const created = await api('POST', '/api/categories', { name: 'Santé', description: 'Health, sport, doctors, physiotherapy, sleep.' });
    expect(created.statusCode).toBe(201);
    expect(created.json().category).toMatchObject({ id: 'sante', name: 'Santé', color: expect.stringMatching(/^#/) });
    expect((await list()).map((c) => c.id)).toEqual(['jobs', 'automata', 'projects', 'learning', 'lifestyle', 'sante', 'other']);

    ctx.ai.nextClassification = { category: 'sante', title: 'Kiné jeudi' };
    const c = await capture('Séance de kiné jeudi à 18 h');
    expect(c.category).toBe('sante');
    const offered = ctx.ai.classifyCalls.at(-1)!.categories;
    expect(offered.find((x) => x.id === 'sante')).toMatchObject({ name: 'Santé', description: 'Health, sport, doctors, physiotherapy, sleep.' });
    const overview = (await api('GET', '/api/overview')).json();
    expect(overview.counts.sante).toBe(1);
    expect(overview.sections.sante.map((x: { id: string }) => x.id)).toEqual([c.id]);
    ctx.ai.nextClassification = { category: 'jobs', title: 'Fake title' };
  });

  it('refuses a second category with the same name, whatever the case', async () => {
    const res = await api('POST', '/api/categories', { name: 'sANTÉ', description: '' });
    expect(res.statusCode).toBe(409);
    expect((await api('PATCH', '/api/categories/learning', { name: 'Jobs' })).statusCode).toBe(409);
  });

  it('renaming moves no capture', async () => {
    ctx.ai.nextClassification = { category: 'jobs', title: 'Offre Qonto' };
    const c = await capture('Offre Automation Lead chez Qonto');
    const res = await api('PATCH', '/api/categories/jobs', { name: 'Career', description: 'Job search and career moves.' });
    expect(res.json().category).toMatchObject({ id: 'jobs', name: 'Career' });
    expect((await api('GET', `/api/captures/${c.id}`)).json().capture.category).toBe('jobs');
    expect((await list()).find((x) => x.id === 'jobs')).toMatchObject({ name: 'Career', description: 'Job search and career moves.' });
  });

  it('Other can be neither renamed nor deleted', async () => {
    expect((await api('PATCH', '/api/categories/other', { name: 'Misc' })).statusCode).toBe(400);
    expect((await api('DELETE', '/api/categories/other')).statusCode).toBe(400);
    expect((await list()).find((x) => x.id === 'other')).toMatchObject({ name: 'Other' });
  });

  it('deleting a category archives its captures under Other; reopened, they stay in Other', async () => {
    await api('POST', '/api/categories', { name: 'Voyages', description: 'Trips.' });
    ctx.ai.nextClassification = { category: 'voyages', title: 'Billets Da Nang' };
    const open = await capture('Réserver les billets pour Da Nang');
    const done = await capture('Passeport renouvelé');
    await api('PATCH', `/api/captures/${done.id}`, { status: 'done' });
    ctx.ai.nextClassification = { category: 'jobs', title: 'Fake title' };

    const res = await api('DELETE', '/api/categories/voyages');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ archived: 2 });
    expect((await list()).map((c) => c.id)).not.toContain('voyages');
    for (const id of [open.id, done.id]) {
      const c = (await api('GET', `/api/captures/${id}`)).json().capture;
      expect(c).toMatchObject({ status: 'archived', category: 'other' });
      expect(c.archivedAt).not.toBeNull();
    }
    // Still readable in the archive.
    const archived = (await api('GET', '/api/captures?status=archived')).json().captures.map((c: { id: string }) => c.id);
    expect(archived).toEqual(expect.arrayContaining([open.id, done.id]));
    const reopened = (await api('PATCH', `/api/captures/${open.id}`, { status: 'open' })).json().capture;
    expect(reopened).toMatchObject({ status: 'open', category: 'other' });
    // A deleted category can no longer be chosen.
    expect((await api('PATCH', `/api/captures/${open.id}`, { category: 'voyages' })).statusCode).toBe(400);
    expect((await api('GET', '/api/overview')).json().counts.voyages).toBeUndefined();
  });

  it('a sorting answer naming a category deleted meanwhile leaves the capture safe, to be sorted again', async () => {
    await api('POST', '/api/categories', { name: 'Éphémère', description: 'Short-lived.' });
    const c = await capture('Une note');
    await api('DELETE', '/api/categories/ephemere');
    // The model still answers with the old list (its call started before the deletion).
    const { classifyCapture } = await import('../src/server/captures/service.js');
    const [row] = await ctx.db.select().from(captures).where(eq(captures.id, c.id));
    await ctx.db.update(captures).set({ classificationStatus: 'pending', categorySource: 'fallback' }).where(eq(captures.id, c.id));
    const ai = { ...ctx.ai, available: true, classify: async () => ({ category: 'ephemere', title: 'x' }) };
    const after = await classifyCapture(ctx.db, ai as never, { ...row!, classificationStatus: 'pending' });
    expect(after.classificationStatus).toBe('failed');
    const [stored] = await ctx.db.select().from(captures).where(eq(captures.id, c.id));
    expect(stored).toMatchObject({ category: row!.category });
  });

  it('keeps each account’s categories to itself', async () => {
    await createUser(ctx.db, 'categories-other@example.com');
    const other = await login(ctx.app, 'categories-other@example.com');
    const theirs = (await api('GET', '/api/categories', undefined, other)).json().categories.map((c: { id: string }) => c.id);
    expect(theirs).not.toContain('sante');
    expect((await api('PATCH', '/api/categories/sante', { name: 'Taken over' }, other)).statusCode).toBe(404);
    expect((await api('DELETE', '/api/categories/sante', undefined, other)).statusCode).toBe(404);
    const [mine] = await ctx.db.select().from(categories).where(and(eq(categories.ownerId, owner), eq(categories.id, 'sante')));
    expect(mine!.name).toBe('Santé');
    // Their capture cannot be filed under a category that only exists for me.
    const c = (await api('POST', '/api/captures', { clientId: newClientId(), kind: 'text', text: 'x' }, other)).json().capture;
    expect((await api('PATCH', `/api/captures/${c.id}`, { category: 'sante' }, other)).statusCode).toBe(400);
  });

  it('the backup carries the categories, and restores them into a fresh account', async () => {
    const backup = (await api('GET', '/api/export')).json();
    expect(backup.categories.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['jobs', 'sante', 'other']));
    expect(backup.categories.find((c: { id: string }) => c.id === 'jobs')).toMatchObject({ name: 'Career' });

    await createUser(ctx.db, 'categories-restore@example.com');
    const fresh = await login(ctx.app, 'categories-restore@example.com');
    const res = await api('POST', '/api/import', backup, fresh);
    expect(res.statusCode).toBe(200);
    const restored = (await api('GET', '/api/categories', undefined, fresh)).json().categories;
    // Added, and the untouched starting one takes the backup's name.
    expect(restored.find((c: { id: string }) => c.id === 'sante')).toMatchObject({ name: 'Santé' });
    expect(restored.find((c: { id: string }) => c.id === 'jobs')).toMatchObject({ name: 'Career', description: 'Job search and career moves.' });
  });

  it('restores starting categories that swapped names with each other', async () => {
    await createUser(ctx.db, 'categories-swap@example.com');
    const swapper = await login(ctx.app, 'categories-swap@example.com');
    // Jobs ↔ Learning through a temporary name, as the API allows.
    await api('PATCH', '/api/categories/jobs', { name: 'Temp' }, swapper);
    await api('PATCH', '/api/categories/learning', { name: 'Jobs', description: 'Now about jobs.' }, swapper);
    await api('PATCH', '/api/categories/jobs', { name: 'Learning', description: 'Now about learning.' }, swapper);
    const backup = (await api('GET', '/api/export', undefined, swapper)).json();

    await createUser(ctx.db, 'categories-swap-restore@example.com');
    const fresh = await login(ctx.app, 'categories-swap-restore@example.com');
    // A category in the destination with any name, including one that looks like a staging name.
    await api('POST', '/api/categories', { name: 'restoring:jobs', description: '' }, fresh);
    expect((await api('POST', '/api/import', backup, fresh)).statusCode).toBe(200);
    const restored = (await api('GET', '/api/categories', undefined, fresh)).json().categories;
    expect(restored.find((c: { id: string }) => c.id === 'jobs')).toMatchObject({ name: 'Learning', description: 'Now about learning.' });
    expect(restored.find((c: { id: string }) => c.id === 'learning')).toMatchObject({ name: 'Jobs', description: 'Now about jobs.' });
  });

  it('restores a category whose name is held by a starting one, under a marked name, with its captures', async () => {
    await createUser(ctx.db, 'categories-reuse@example.com');
    const source = await login(ctx.app, 'categories-reuse@example.com');
    // Jobs deleted, then its name reused by a new category holding captures.
    await api('DELETE', '/api/categories/jobs', undefined, source);
    await api('POST', '/api/categories', { name: 'Applications', description: 'Where I applied.' }, source);
    await api('PATCH', '/api/categories/applications', { name: 'Jobs' }, source);
    ctx.ai.nextClassification = { category: 'applications', title: 'Candidature Alan' };
    const c = (await api('POST', '/api/captures', { clientId: newClientId(), kind: 'text', text: 'Candidature Alan envoyée' }, source)).json().capture;
    ctx.ai.nextClassification = { category: 'jobs', title: 'Fake title' };
    expect(c.category).toBe('applications');
    const backup = (await api('GET', '/api/export', undefined, source)).json();
    // Restored into a database that no longer has the capture (lost), for a fresh account.
    await ctx.db.delete(captures).where(eq(captures.id, c.id));
    await createUser(ctx.db, 'categories-reuse-restore@example.com');
    const fresh = await login(ctx.app, 'categories-reuse-restore@example.com');
    expect((await api('POST', '/api/import', backup, fresh)).statusCode).toBe(200);
    const restored = (await api('GET', '/api/categories', undefined, fresh)).json().categories;
    expect(restored.find((x: { id: string }) => x.id === 'applications')).toMatchObject({ name: 'Jobs (restored)', description: 'Where I applied.' });
    const [back] = await ctx.db.select().from(captures).where(eq(captures.id, c.id));
    expect(back).toMatchObject({ category: 'applications' });
  });

  it('a category id that is also an Object property ("constructor") is just a category', async () => {
    const res = await api('POST', '/api/categories', { name: 'Constructor', description: 'Building work at home.' });
    expect(res.json().category.id).toBe('constructor');
    const { renderToString } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { CategoryIcon } = await import('../src/web/components/CategoryIcon.js');
    expect(renderToString(createElement(CategoryIcon, { category: 'constructor' }))).toContain('<svg');
    // Counts and sections read it as data: a number and a list, never Object's own constructor.
    ctx.ai.nextClassification = { category: 'constructor', title: 'Plombier' };
    await capture('Appeler le plombier pour la salle de bain');
    ctx.ai.nextClassification = { category: 'jobs', title: 'Fake title' };
    const overview = (await api('GET', '/api/overview')).json();
    expect(overview.counts.constructor).toBe(1);
    expect(overview.sections.constructor).toHaveLength(1);
    const { byCategory } = await import('../src/shared/categories.js');
    // An overview loaded before the category existed (another device added it meanwhile).
    expect(byCategory({ jobs: [] as unknown[] }, 'constructor')).toBeUndefined();
  });

  it('an old backup without categories still restores, unknown categories under Other', async () => {
    const backup = (await api('GET', '/api/export')).json();
    const { categories: _dropped, ...old } = backup;
    const first = backup.captures[0];
    old.captures = [
      { ...first, id: crypto.randomUUID(), clientId: crypto.randomUUID(), category: 'lifestyle' },
      { ...first, id: crypto.randomUUID(), clientId: crypto.randomUUID(), category: 'gone-since' },
    ];
    await createUser(ctx.db, 'categories-old@example.com');
    const fresh = await login(ctx.app, 'categories-old@example.com');
    const res = await api('POST', '/api/import', { ...old, projects: [], projectLinks: [] }, fresh);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inserted: 2 });
    const restored = (await api('GET', '/api/captures?status=all', undefined, fresh)).json().captures;
    expect(restored.map((c: { category: string }) => c.category).sort()).toEqual(['lifestyle', 'other']);
  });

});
