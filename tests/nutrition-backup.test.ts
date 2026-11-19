import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captures, nutritionEntries } from '../src/server/db/schema.js';
import { localDay, type NutritionEntry } from '../src/shared/nutrition.js';
import { JPEG, createUser, login, newClientId, photoPayload, setup, type TestContext } from './helpers.js';

// The JSON backup carries the Nutrition data, and a file from before the section existed still
// restores exactly as it did.

let ctx: TestContext;
let cookie: string;
const NONE = { inserted: 0, skipped: 0, deleted: 0 };

beforeEach(async () => {
  ctx = await setup();
  await createUser(ctx.db, 'julien@example.com');
  cookie = await login(ctx.app, 'julien@example.com');
});
afterEach(() => ctx.close());

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, as = cookie) =>
  ctx.app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });
const exportAs = async (as = cookie) => (await call('GET', '/api/export', undefined, as)).json();
const importAs = (file: unknown, as = cookie) => call('POST', '/api/import', file as object, as);

async function meal(text = 'une banane', confirmed = true): Promise<NutritionEntry> {
  const { nutrition } = (await call('POST', '/api/nutrition/entries', { clientId: newClientId(), text })).json();
  if (confirmed) await call('PATCH', `/api/nutrition/entries/${nutrition.id}`, { status: 'confirmed' });
  return nutrition;
}
async function note(text: string) {
  ctx.ai.nextClassification = { category: 'lifestyle', title: text, intent: 'note' };
  return (await call('POST', '/api/captures', { clientId: newClientId(), kind: 'text', text })).json().capture;
}

/** A second, empty instance to restore into. */
async function fresh(run: (other: TestContext, otherCookie: string) => Promise<void>) {
  const other = await setup();
  try {
    await createUser(other.db, 'julien@example.com');
    await run(other, await login(other.app, 'julien@example.com'));
  } finally {
    await other.close();
  }
}

describe('export', () => {
  it('includes every entry, confirmed or not, and the goal; never the pictures', async () => {
    const eaten = await meal();
    const waiting = await meal('un café', false);
    await call('POST', '/api/nutrition/entries', { clientId: newClientId(), weightKg: 78.4 });
    await call('PUT', '/api/nutrition/settings', { kcalGoal: 2300 });
    const { payload, headers } = await photoPayload({ clientId: newClientId() }, JPEG, JPEG);
    await ctx.app.inject({ method: 'POST', url: '/api/captures/photo', headers: { cookie, ...headers }, payload });

    const file = await exportAs();
    expect(file).toMatchObject({ format: 'brain-capture-export', version: 1 });
    expect(file.nutrition.settings).toEqual({ kcalGoal: 2300 });
    expect(file.nutrition.entries).toHaveLength(4);
    const byId = Object.fromEntries(file.nutrition.entries.map((e: { id: string }) => [e.id, e]));
    expect(byId[eaten.id]).toMatchObject({ type: 'meal', status: 'confirmed', day: localDay(new Date(), 'Europe/Paris'), originalText: 'une banane', data: { items: [{ name: 'banane', source: 'ciqual' }] } });
    expect(byId[waiting.id]).toMatchObject({ status: 'proposed' });
    expect(JSON.stringify(file)).not.toContain('hasPhoto');
    expect(JSON.stringify(file)).not.toContain('/9j/');
    // Nutrition entries are not captures.
    expect(file.captures).toEqual([]);
  });

  it('an account without Nutrition data exports an empty section', async () => {
    expect((await exportAs()).nutrition).toEqual({ entries: [], settings: null });
  });
});

describe('restore', () => {
  it('into an empty database: same entries field by field, same totals, and a second run changes nothing', async () => {
    await meal();
    await meal('un café', false);
    await call('POST', '/api/nutrition/entries', { clientId: newClientId(), weightKg: 78.4 });
    await call('PUT', '/api/nutrition/settings', { kcalGoal: 2300 });
    await note('Appeler le plombier');
    const original = await exportAs();
    const day = localDay(new Date(), 'Europe/Paris');
    const totals = (await call('GET', `/api/nutrition/day?day=${day}`)).json().totals;

    await fresh(async (other, otherCookie) => {
      const first = await other.app.inject({ method: 'POST', url: '/api/import', headers: { cookie: otherCookie }, payload: original });
      expect(first.json()).toEqual({ inserted: 1, skipped: 0, deleted: 0, total: 1, nutrition: { inserted: 3, skipped: 0, deleted: 0 } });
      const restored = (await other.app.inject({ method: 'GET', url: '/api/export', headers: { cookie: otherCookie } })).json();
      expect(restored.nutrition).toEqual(original.nutrition);
      expect(restored.captures).toEqual(original.captures);
      const view = (await other.app.inject({ method: 'GET', url: `/api/nutrition/day?day=${day}`, headers: { cookie: otherCookie } })).json();
      expect(view.totals).toEqual(totals);
      expect(view.pending).toHaveLength(1);

      const second = await other.app.inject({ method: 'POST', url: '/api/import', headers: { cookie: otherCookie }, payload: original });
      expect(second.json()).toEqual({ inserted: 0, skipped: 1, deleted: 0, total: 1, nutrition: { inserted: 0, skipped: 3, deleted: 0 } });
      expect(await other.db.select().from(nutritionEntries)).toHaveLength(3);
    });
  });

  it('a backup from before the Nutrition section restores as it always did', async () => {
    const before = await note('Old note');
    const file = await exportAs();
    // Exactly what an older version wrote: no nutrition key at all.
    delete file.nutrition;
    expect(Object.keys(file.captures[0])).not.toContain('keptAsNote');
    await meal();

    await fresh(async (other, otherCookie) => {
      const res = await other.app.inject({ method: 'POST', url: '/api/import', headers: { cookie: otherCookie }, payload: file });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ inserted: 1, skipped: 0, deleted: 0, total: 1, nutrition: NONE });
      const restored = (await other.app.inject({ method: 'GET', url: '/api/export', headers: { cookie: otherCookie } })).json();
      expect(restored.captures).toEqual(file.captures);
      expect(restored.captures[0].id).toBe(before.id);
    });
    // Into the live account: the entry made since is untouched.
    expect((await importAs(file)).json()).toEqual({ inserted: 0, skipped: 1, deleted: 0, total: 1, nutrition: NONE });
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(1);
  });

  it('never overwrites: an entry edited since the backup keeps its edits, the goal stays', async () => {
    const entry = await meal();
    await call('PUT', '/api/nutrition/settings', { kcalGoal: 2300 });
    const file = await exportAs();
    await call('PATCH', `/api/nutrition/entries/${entry.id}`, { title: 'Corrigé depuis' });
    await call('PUT', '/api/nutrition/settings', { kcalGoal: 1900 });
    expect((await importAs(file)).json().nutrition).toEqual({ inserted: 0, skipped: 1, deleted: 0 });
    expect((await call('GET', `/api/nutrition/entries/${entry.id}`)).json().nutrition.title).toBe('Corrigé depuis');
    expect((await call('GET', '/api/nutrition/settings')).json().kcalGoal).toBe(1900);
  });

  it('what was deleted since stays deleted', async () => {
    const entry = await meal();
    const file = await exportAs();
    await call('DELETE', `/api/nutrition/entries/${entry.id}`);
    expect((await importAs(file)).json().nutrition).toEqual({ inserted: 0, skipped: 0, deleted: 1 });
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(0);
  });

  it('a capture lives in one place: neither a note recognised as a meal since, nor an entry turned into a note since, comes back twice', async () => {
    // Backup taken while the capture was still a note (the model was down).
    ctx.ai.failClassify = true;
    const pending = (await call('POST', '/api/captures', { clientId: newClientId(), kind: 'text', text: 'une banane', nutrition: true })).json().capture;
    const whileNote = await exportAs();
    expect(whileNote.captures).toHaveLength(1);
    ctx.ai.failClassify = false;
    await call('POST', `/api/captures/${pending.id}/nutrition`);
    expect(await ctx.db.select().from(captures)).toHaveLength(0);

    expect((await importAs(whileNote)).json()).toMatchObject({ inserted: 0, total: 1 });
    expect(await ctx.db.select().from(captures)).toHaveLength(0);
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(1);

    // And the other way: backed up as an entry, a note by now.
    const whileEntry = await exportAs();
    await call('POST', `/api/nutrition/entries/${pending.id}/note`);
    expect((await importAs(whileEntry)).json().nutrition).toEqual({ inserted: 0, skipped: 1, deleted: 0 });
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(0);
    expect(await ctx.db.select().from(captures)).toHaveLength(1);
  });

  it('skips an entry whose data makes no sense instead of storing it, and refuses a malformed file', async () => {
    await meal();
    const file = await exportAs();
    const broken = { ...file, nutrition: { entries: [{ ...file.nutrition.entries[0], id: newClientId(), clientId: newClientId(), data: { items: 'banane' } }], settings: null } };
    expect((await importAs(broken)).json().nutrition).toEqual({ inserted: 0, skipped: 1, deleted: 0 });
    for (const bad of [{ entries: [{ id: 'nope' }] }, { entries: [{ ...file.nutrition.entries[0], day: '2026-02-30' }] }, { entries: [], settings: { kcalGoal: 5 } }]) {
      expect((await importAs({ ...file, nutrition: bad })).statusCode).toBe(400);
    }
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(1);
  });

  it('cannot take over another account’s entry with a forged id', async () => {
    const entry = await meal();
    const file = await exportAs();
    await createUser(ctx.db, 'other@example.com');
    const stranger = await login(ctx.app, 'other@example.com');
    const forged = { ...file, captures: [], nutrition: { entries: [{ ...file.nutrition.entries[0], clientId: newClientId(), title: 'Taken over' }], settings: null } };
    expect((await importAs(forged, stranger)).json().nutrition).toEqual({ inserted: 0, skipped: 1, deleted: 0 });
    expect((await call('GET', `/api/nutrition/entries/${entry.id}`)).json().nutrition.title).not.toBe('Taken over');
    expect((await exportAs(stranger)).nutrition.entries).toEqual([]);
  });
});
