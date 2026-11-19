import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepClassifications } from '../src/server/captures/sweeper.js';
import { captureEvents, captures, nutritionEntries } from '../src/server/db/schema.js';
import { createFoodLookup } from '../src/server/nutrition/foods.js';
import { localDay, type NutritionEntry } from '../src/shared/nutrition.js';
import type { Capture } from '../src/shared/types.js';
import { createUser, food, login, meal, newClientId, notNutrition, setup, voicePayload, weight, workout, type TestContext } from './helpers.js';

// What a capture is decides where it lives. A meal, a workout or a weigh-in goes to Nutrition
// and is never a note: no category, no history, no Today, no counter. Everything else is a note
// exactly as before.

let ctx: TestContext;
let cookie: string;
const foods = createFoodLookup({ fetchImpl: null });

beforeEach(async () => {
  ctx = await setup();
  await createUser(ctx.db, 'julien@example.com');
  cookie = await login(ctx.app, 'julien@example.com');
});
afterEach(() => ctx.close());

type Saved = { capture?: Capture; nutrition?: NutritionEntry; created: boolean };

/** A capture sent by the current app, which knows the Nutrition section. */
async function send(text: string, extra: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/captures',
    headers: { cookie },
    payload: { clientId: newClientId(), kind: 'text', text, nutrition: true, ...extra },
  });
}
const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });
const notes = async () => (await get('/api/captures?status=all')).json().captures as Capture[];
const noteRows = () => ctx.db.select().from(captures);
const entryRows = () => ctx.db.select().from(nutritionEntries);
const later = () => new Date(Date.now() + 3_600_000);

describe('the four examples of the brief', () => {
  it('« j’ai mangé une banane » is a meal: an entry to confirm, with table values, and no note anywhere', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane mangée', intent: 'meal' };
    ctx.ai.nextNutrition = meal([food('banane', 'banane crue', 120, 89)], { title: 'Banane' });
    const res = await send("j'ai mangé une banane");
    expect(res.statusCode).toBe(201);
    const body = res.json() as Saved;
    expect(body.capture).toBeUndefined();
    expect(body.nutrition).toMatchObject({ type: 'meal', status: 'proposed', source: 'text', title: 'Banane', originalText: "j'ai mangé une banane" });
    const [item] = (body.nutrition as Extract<NutritionEntry, { type: 'meal' }>).data.items;
    // Ciqual: 88 kcal per 100 g, so 106 for 120 g. Not the model's 89.
    expect(item).toMatchObject({ name: 'banane', grams: 120, kcal: 106, source: 'ciqual', ref: 'Banane, chair sans peau, crue' });

    // Not a note: no row, no list, no category count, no "recent", no Today.
    expect(await noteRows()).toHaveLength(0);
    expect(await notes()).toEqual([]);
    const overview = (await get('/api/overview')).json();
    expect(Object.values(overview.counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(0);
    expect(overview).toMatchObject({ recent: 0, done: 0, archived: 0 });
    expect((await get('/api/captures?status=all&q=banane')).json().captures).toEqual([]);
    const today = await get('/api/today?timeZone=Europe/Paris');
    expect(JSON.stringify(today.json())).not.toContain('banane');
  });

  it('« acheter des bananes » is a note: sorted into a category, nothing asked about nutrition', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Acheter des bananes', intent: 'note' };
    const body = (await send('acheter des bananes')).json() as Saved;
    expect(body.nutrition).toBeUndefined();
    expect(body.capture).toMatchObject({ category: 'lifestyle', title: 'Acheter des bananes', classificationStatus: 'done' });
    expect(ctx.ai.nutritionCalls).toHaveLength(0);
    expect(await entryRows()).toHaveLength(0);
  });

  it('« 45 min de vélo » is a workout, with calories from MET × weight × time', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Vélo', intent: 'workout' };
    ctx.ai.nextNutrition = workout('Vélo', 45, 7.5, { title: 'Vélo 45 min' });
    const body = (await send('45 min de vélo')).json() as Saved;
    // No weigh-in yet: 75 kg. 7.5 × 75 × 0.75 h = 421.875.
    expect(body.nutrition).toMatchObject({ type: 'workout', status: 'proposed', title: 'Vélo 45 min', data: { activity: 'Vélo', minutes: 45, met: 7.5, kcal: 422, weightKg: 75 } });
    expect(await noteRows()).toHaveLength(0);
  });

  it('« je pèse 78,4 » is a weigh-in', async () => {
    ctx.ai.nextClassification = { category: 'other', title: '78,4 kg', intent: 'weight' };
    ctx.ai.nextNutrition = weight(78.4);
    const body = (await send('je pèse 78,4')).json() as Saved;
    expect(body.nutrition).toMatchObject({ type: 'weight', status: 'proposed', title: '78.4 kg', data: { kg: 78.4 } });
    expect(await noteRows()).toHaveLength(0);
  });
});

describe('what stays a note', () => {
  it('a calendar request stays a calendar request, even when it talks about lunch', async () => {
    // Worst case: the first reading calls it a meal. The explicit request wins.
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Déjeuner avec Sarah', intent: 'meal' };
    const body = (await send('Mets dans mon agenda déjeuner avec Sarah vendredi à 12h30')).json() as Saved;
    expect(body.capture).toBeDefined();
    expect(ctx.ai.nutritionCalls).toHaveLength(0);
    expect(await entryRows()).toHaveLength(0);
    expect(await ctx.db.select().from(captureEvents)).toHaveLength(1);
  });

  it('a link is never a meal', async () => {
    ctx.ai.nextClassification = { category: 'learning', title: 'Recette', intent: 'meal' };
    const body = (await send('', { kind: 'link', url: 'https://www.marmiton.org/recettes/banana-bread' })).json() as Saved;
    expect(body.capture).toMatchObject({ kind: 'link', category: 'learning' });
    expect(ctx.ai.nutritionCalls).toHaveLength(0);
  });

  it('the full reading has the last word: when it finds nothing to log, the note is sorted as usual', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Recette de banana bread', intent: 'meal' };
    ctx.ai.nextNutrition = notNutrition();
    const body = (await send('Tester la recette de banana bread de Marie')).json() as Saved;
    expect(body.capture).toMatchObject({ category: 'lifestyle', classificationStatus: 'done' });
    expect(await entryRows()).toHaveLength(0);
  });

  it('an app version that does not know Nutrition yet keeps getting its note back', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane mangée', intent: 'meal' };
    const res = await ctx.app.inject({ method: 'POST', url: '/api/captures', headers: { cookie }, payload: { clientId: newClientId(), kind: 'text', text: "j'ai mangé une banane" } });
    const body = res.json() as Saved;
    expect(body.capture).toMatchObject({ classificationStatus: 'done', category: 'lifestyle' });
    expect(body.nutrition).toBeUndefined();
    expect(ctx.ai.nutritionCalls).toHaveLength(0);
  });

  it('and its captures are not moved later by the retry sweep either', async () => {
    // The model is down when the older app sends its capture, then comes back.
    ctx.ai.failClassify = true;
    const clientId = newClientId();
    const old = () => ctx.app.inject({ method: 'POST', url: '/api/captures', headers: { cookie }, payload: { clientId, kind: 'text', text: "j'ai mangé une banane" } });
    expect((await old()).json().capture).toMatchObject({ classificationStatus: 'failed' });
    ctx.ai.failClassify = false;
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane mangée', intent: 'meal' };
    expect(await sweepClassifications(ctx.db, ctx.ai, later(), foods)).toBe(1);
    expect(await entryRows()).toHaveLength(0);
    expect(ctx.ai.nutritionCalls).toHaveLength(0);
    // Its retry after a lost answer still gets a capture, the only thing it can read.
    const again = (await old()).json() as Saved;
    expect(again.capture).toMatchObject({ category: 'lifestyle', classificationStatus: 'done' });
    expect(again.nutrition).toBeUndefined();
    // From the current app, he can still log it in Nutrition himself.
    const moved = await ctx.app.inject({ method: 'POST', url: `/api/captures/${again.capture!.id}/nutrition`, headers: { cookie } });
    expect(moved.json().nutrition).toMatchObject({ type: 'meal' });
  });
});

describe('when the model cannot be asked', () => {
  it('nothing is lost: the capture is saved, then moves to Nutrition when the retry recognises it', async () => {
    ctx.ai.failClassify = true;
    // Captured in Da Nang two hours ago: the entry must land on that local day, not the server's.
    const capturedAt = Date.now() - 2 * 3_600_000;
    const saved = (await send("j'ai mangé une banane", { capturedAt, timeZone: 'Asia/Ho_Chi_Minh' })).json() as Saved;
    expect(saved.capture).toMatchObject({ classificationStatus: 'failed', category: 'other' });

    ctx.ai.failClassify = false;
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane', intent: 'meal' };
    expect(await sweepClassifications(ctx.db, ctx.ai, later(), foods)).toBe(1);
    expect(await noteRows()).toHaveLength(0);
    const [entry] = await entryRows();
    expect(entry).toMatchObject({ id: saved.capture!.id, clientId: saved.capture!.clientId, type: 'meal', status: 'proposed', day: localDay(new Date(capturedAt), 'Asia/Ho_Chi_Minh') });
    expect(ctx.ai.nutritionCalls[0]).toMatchObject({ timeZone: 'Asia/Ho_Chi_Minh' });
  });

  it('a meal whose details could not be read is not filed under a category: it is retried', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane', intent: 'meal' };
    ctx.ai.failNutrition = true;
    const saved = (await send("j'ai mangé une banane")).json() as Saved;
    expect(saved.capture).toMatchObject({ classificationStatus: 'failed', category: 'other' });

    ctx.ai.failNutrition = false;
    await sweepClassifications(ctx.db, ctx.ai, later(), foods);
    expect(await noteRows()).toHaveLength(0);
    expect(await entryRows()).toHaveLength(1);
  });

  it('without a key, the capture simply waits as a note', async () => {
    ctx.ai.available = false;
    const saved = (await send("j'ai mangé une banane")).json() as Saved;
    expect(saved.capture).toMatchObject({ classificationStatus: 'pending' });
    expect(await entryRows()).toHaveLength(0);
  });
});

describe('one capture, stored once, in one place', () => {
  it('a retry after a lost answer gets the same entry back, without asking the model again', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane', intent: 'meal' };
    const clientId = newClientId();
    const first = (await send("j'ai mangé une banane", { clientId })).json() as Saved;
    const again = await send("j'ai mangé une banane", { clientId });
    expect(again.statusCode).toBe(200);
    expect((again.json() as Saved).nutrition!.id).toBe(first.nutrition!.id);
    expect((again.json() as Saved).created).toBe(false);
    expect(ctx.ai.nutritionCalls).toHaveLength(1);
    expect(await entryRows()).toHaveLength(1);
    expect(await noteRows()).toHaveLength(0);
  });

  it('a deleted entry does not come back when the phone sends it again', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane', intent: 'meal' };
    const clientId = newClientId();
    const { nutrition } = (await send("j'ai mangé une banane", { clientId })).json() as Saved;
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/nutrition/entries/${nutrition!.id}`, headers: { cookie } });
    expect(del.json()).toEqual({ deleted: true });
    const again = await send("j'ai mangé une banane", { clientId });
    expect(again.statusCode).toBe(410);
    expect(again.json().error).toBe('capture_deleted');
    expect(await entryRows()).toHaveLength(0);
    expect(await noteRows()).toHaveLength(0);
  });

  it('a dictated meal goes the same way, and its retry is not transcribed twice', async () => {
    ctx.ai.transcript = "J'ai mangé une banane.";
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane', intent: 'meal' };
    const clientId = newClientId();
    const upload = async () => {
      const { payload, headers } = await voicePayload({ clientId, durationMs: '2400', device: 'android', nutrition: '1' }, new Uint8Array([1, 2, 3]));
      return ctx.app.inject({ method: 'POST', url: '/api/captures/voice', headers: { cookie, ...headers }, payload });
    };
    const first = await upload();
    expect(first.statusCode).toBe(201);
    expect((first.json() as Saved).nutrition).toMatchObject({ type: 'meal', source: 'voice', originalText: "J'ai mangé une banane." });
    const again = await upload();
    expect(again.statusCode).toBe(200);
    expect((again.json() as Saved).nutrition!.id).toBe((first.json() as Saved).nutrition!.id);
    expect(ctx.ai.transcribeCalls).toBe(1);
    expect(await noteRows()).toHaveLength(0);
  });
});

describe('correcting the detection, both ways', () => {
  it('« It’s a note »: the entry becomes the note it should have been, and stays one', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane', intent: 'meal' };
    const { nutrition } = (await send('Banane plantain, idée de plat pour samedi')).json() as Saved;

    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Idée de plat samedi', intent: 'meal' };
    const res = await ctx.app.inject({ method: 'POST', url: `/api/nutrition/entries/${nutrition!.id}/note`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // Same id and same text; sorted into a category although the model still says "meal".
    expect(res.json().capture).toMatchObject({
      id: nutrition!.id,
      clientId: nutrition!.clientId,
      text: 'Banane plantain, idée de plat pour samedi',
      category: 'lifestyle',
      title: 'Idée de plat samedi',
      classificationStatus: 'done',
    });
    expect(await entryRows()).toHaveLength(0);
    expect(await notes()).toHaveLength(1);
    // A second tap (lost answer) answers with the same note.
    const twice = await ctx.app.inject({ method: 'POST', url: `/api/nutrition/entries/${nutrition!.id}/note`, headers: { cookie } });
    expect(twice.json().capture.id).toBe(nutrition!.id);

    // Even a later sorting pass leaves it among the notes.
    await ctx.db.update(captures).set({ classificationStatus: 'pending', updatedAt: new Date(0) });
    await sweepClassifications(ctx.db, ctx.ai, later(), foods);
    expect(await entryRows()).toHaveLength(0);
    expect(await noteRows()).toHaveLength(1);
  });

  it('« Log in Nutrition »: a note the detection missed becomes an entry on his say-so', async () => {
    ctx.ai.nextClassification = { category: 'other', title: 'Banane', intent: 'note' };
    const { capture } = (await send('une banane')).json() as Saved;
    expect(capture).toBeDefined();

    const res = await ctx.app.inject({ method: 'POST', url: `/api/captures/${capture!.id}/nutrition`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().nutrition).toMatchObject({ id: capture!.id, type: 'meal', status: 'proposed', originalText: 'une banane' });
    expect(await noteRows()).toHaveLength(0);

    // A transcription corrected by hand is read as corrected, and the correction is kept.
    ctx.ai.nextClassification = { category: 'other', title: 'Bananes', intent: 'note' };
    const { capture: misheard } = (await send('une bande Anne')).json() as Saved;
    await ctx.app.inject({ method: 'PATCH', url: `/api/captures/${misheard!.id}`, headers: { cookie }, payload: { text: 'une banane' } });
    const fixed = await ctx.app.inject({ method: 'POST', url: `/api/captures/${misheard!.id}/nutrition`, headers: { cookie } });
    expect(ctx.ai.nutritionCalls.at(-1)!.text).toBe('une banane');
    expect(fixed.json().nutrition.originalText).toBe('une banane');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/nutrition/entries/${misheard!.id}/note`, headers: { cookie } })).json().capture.text).toBe('une banane');
    await ctx.app.inject({ method: 'DELETE', url: `/api/captures/${misheard!.id}`, headers: { cookie } });

    // Nothing to log in it: said so, and the note is left alone.
    const { capture: other } = (await send('Rappeler le plombier')).json() as Saved;
    ctx.ai.nextNutrition = notNutrition();
    const refused = await ctx.app.inject({ method: 'POST', url: `/api/captures/${other!.id}/nutrition`, headers: { cookie } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('not_nutrition');
    expect(await noteRows()).toHaveLength(1);
  });

  it('cannot move another account’s entry or note', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Banane', intent: 'meal' };
    const { nutrition } = (await send("j'ai mangé une banane")).json() as Saved;
    ctx.ai.nextClassification = { category: 'other', title: 'Note', intent: 'note' };
    const { capture } = (await send('une pomme')).json() as Saved;
    await createUser(ctx.db, 'other@example.com');
    const stranger = await login(ctx.app, 'other@example.com');
    for (const url of [`/api/nutrition/entries/${nutrition!.id}/note`, `/api/captures/${capture!.id}/nutrition`]) {
      const res = await ctx.app.inject({ method: 'POST', url, headers: { cookie: stranger } });
      expect(res.statusCode).toBe(404);
    }
    expect(await entryRows()).toHaveLength(1);
    expect(await noteRows()).toHaveLength(1);
  });
});
