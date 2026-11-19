import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captures, deletedCaptures, nutritionEntries, nutritionPhotos } from '../src/server/db/schema.js';
import { createFoodLookup } from '../src/server/nutrition/foods.js';
import { localDay, shiftDay, type MealData, type NutritionDay, type NutritionEntry, type NutritionHistory } from '../src/shared/nutrition.js';
import { JPEG, createUser, food, login, meal, newClientId, notNutrition, photoPayload, setup, weight, workout, type TestContext } from './helpers.js';

let ctx: TestContext;
let cookie: string;
const ZONE = 'Europe/Paris';
const today = () => localDay(new Date(), ZONE);

beforeEach(async () => {
  ctx = await setup();
  await createUser(ctx.db, 'julien@example.com');
  cookie = await login(ctx.app, 'julien@example.com');
});
afterEach(() => ctx.close());

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, as = cookie) =>
  ctx.app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });
const day = async (d = today(), as = cookie) => (await call('GET', `/api/nutrition/day?day=${d}&timeZone=${ZONE}`, undefined, as)).json() as NutritionDay;

/** A sentence typed in the Nutrition section: read, then waiting for a tap. */
async function log(text: string, extra: Record<string, unknown> = {}): Promise<NutritionEntry> {
  const res = await call('POST', '/api/nutrition/entries', { clientId: newClientId(), text, timeZone: ZONE, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json().nutrition;
}
async function confirm(id: string, patch: Record<string, unknown> = {}): Promise<NutritionEntry> {
  const res = await call('PATCH', `/api/nutrition/entries/${id}`, { status: 'confirmed', ...patch });
  expect(res.statusCode).toBe(200);
  return res.json().nutrition;
}
async function weigh(kg: number, extra: Record<string, unknown> = {}) {
  return call('POST', '/api/nutrition/entries', { clientId: newClientId(), weightKg: kg, timeZone: ZONE, ...extra });
}
async function photo(fields: Record<string, string> = {}, image: Uint8Array | null = JPEG, thumb: Uint8Array | null = JPEG) {
  const { payload, headers } = await photoPayload({ clientId: newClientId(), timeZone: ZONE, device: 'android', ...fields }, image, thumb);
  return ctx.app.inject({ method: 'POST', url: '/api/captures/photo', headers: { cookie, ...headers }, payload });
}

describe('an entry counts once confirmed', () => {
  it('waits under "to confirm" without touching the totals, then counts in the day', async () => {
    ctx.ai.nextNutrition = meal([food('poulet', 'poulet filet cuit', 130, 165), food('riz', 'riz blanc cuit', 250, 130)], { slot: 'lunch', title: 'Poulet riz' });
    const entry = await log('poulet riz ce midi');
    expect(entry).toMatchObject({ status: 'proposed', type: 'meal', day: today(), data: { slot: 'lunch' } });

    let view = await day();
    expect(view.entries).toEqual([]);
    expect(view.pending.map((e) => e.id)).toEqual([entry.id]);
    expect(view.totals).toMatchObject({ eaten: { kcal: 0 }, burned: 0, goal: 2000, remaining: 2000 });
    expect(view.settings).toEqual({ kcalGoal: 2000, goalSet: false });

    await confirm(entry.id);
    view = await day();
    expect(view.pending).toEqual([]);
    expect(view.entries.map((e) => e.id)).toEqual([entry.id]);
    const items = (view.entries[0]!.data as MealData).items;
    const kcal = items.reduce((n, i) => n + i.kcal, 0);
    expect(kcal).toBeGreaterThan(400);
    expect(view.totals.eaten.kcal).toBe(kcal);
    expect(view.totals.remaining).toBe(2000 - kcal);
  });

  it('the card can be corrected before the tap: quantities, values, name, day', async () => {
    const entry = await log('une banane');
    const [banana] = (entry.data as MealData).items;
    const edited = { slot: 'snack', items: [{ ...banana!, grams: 240, kcal: 212, protein: 2.6, carbs: 47.3, fat: 0.7 }, { name: 'Café', grams: 100, kcal: 2, protein: 0, carbs: 0, fat: 0, per100: null, source: 'manual', ref: null }] };
    const yesterday = shiftDay(today(), -1);
    const saved = await confirm(entry.id, { data: edited, title: 'Deux bananes et un café', day: yesterday });
    expect(saved).toMatchObject({ status: 'confirmed', title: 'Deux bananes et un café', day: yesterday });
    expect((saved.data as MealData).items).toHaveLength(2);
    expect((await day(yesterday)).totals.eaten.kcal).toBe(214);
    expect((await day()).entries).toEqual([]);
  });

  it('refuses values that make no sense, and an empty meal cannot be confirmed', async () => {
    const entry = await log('une banane');
    expect((await call('PATCH', `/api/nutrition/entries/${entry.id}`, { day: shiftDay(today(), 3) })).statusCode).toBe(400);
    const bad = await call('PATCH', `/api/nutrition/entries/${entry.id}`, { data: { slot: 'snack', items: [{ name: 'x', grams: -5, kcal: 10, protein: 0, carbs: 0, fat: 0 }] } });
    expect(bad.statusCode).toBe(400);
    const empty = await call('PATCH', `/api/nutrition/entries/${entry.id}`, { status: 'confirmed', data: { slot: 'snack', items: [] } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toBe('Add at least one food.');
    expect((await day()).entries).toEqual([]);
  });

  it('« hier soir » lands on the day before', async () => {
    ctx.ai.nextNutrition = meal([food('pizza', 'pizza margherita', 350, 250)], { dayOffset: -1, slot: 'dinner' });
    const entry = await log("hier soir j'ai mangé une pizza");
    expect(entry.day).toBe(shiftDay(today(), -1));
  });

  it('a food no table knows keeps the model’s estimate, and says so', async () => {
    ctx.ai.nextNutrition = meal([food('pad thaï', 'pad thaï', 400, 160)]);
    const [item] = ((await log('un pad thaï')).data as MealData).items;
    expect(item).toMatchObject({ source: 'estimate', ref: null, kcal: 640, per100: { kcal: 160 } });
  });

  it('a product named by its brand takes its values from Open Food Facts, else falls back', async () => {
    const offCalls: string[] = [];
    const product = { product_name: 'Activia Nature', brands: 'Activia,Danone', nutriments: { 'energy-kcal_100g': 62, proteins_100g: 4.1, carbohydrates_100g: 5.6, fat_100g: 2.9 } };
    let status = 200;
    const fetchImpl = (async (url: string | URL) => {
      offCalls.push(String(url));
      return new Response(JSON.stringify({ products: [product] }), { status });
    }) as typeof fetch;
    await ctx.close();
    ctx = await setup({}, { foods: createFoodLookup({ fetchImpl }) });
    await createUser(ctx.db, 'julien@example.com');
    cookie = await login(ctx.app, 'julien@example.com');

    ctx.ai.nextNutrition = meal([food('yaourt Activia', 'yaourt nature', 125, 60, 'Activia')]);
    const [fromOff] = ((await log('un Activia nature')).data as MealData).items;
    expect(fromOff).toMatchObject({ source: 'off', ref: 'Activia Nature · Activia', kcal: 78 });
    expect(offCalls[0]).toContain('search_terms=Activia');

    // The service is down (it happens): same food from the Ciqual table instead.
    status = 503;
    ctx.ai.nextNutrition = meal([food('yaourt Danone', 'yaourt nature', 125, 60, 'Danone')]);
    const [fromTable] = ((await log('un yaourt Danone')).data as MealData).items;
    expect(fromTable!.source).toBe('ciqual');
  });
});

describe('workouts and the day balance', () => {
  it('a workout gives calories back: remaining = goal − eaten + burned', async () => {
    await call('PUT', '/api/nutrition/settings', { kcalGoal: 2200 });
    ctx.ai.nextNutrition = meal([food('pâtes', 'pâtes cuites', 300, 150)]);
    await confirm((await log('des pâtes')).id);
    ctx.ai.nextNutrition = workout('Vélo', 45, 7.5);
    await confirm((await log('45 min de vélo')).id);

    const view = await day();
    const eaten = view.totals.eaten.kcal;
    expect(eaten).toBeGreaterThan(0);
    expect(view.totals).toMatchObject({ burned: 422, goal: 2200, remaining: 2200 - eaten + 422 });
    expect(view.settings).toEqual({ kcalGoal: 2200, goalSet: true });
  });

  it('uses the latest weigh-in for the estimate', async () => {
    expect((await weigh(80)).statusCode).toBe(201);
    ctx.ai.nextNutrition = workout('Vélo', 45, 7.5);
    const entry = await log('45 min de vélo');
    expect(entry.data).toMatchObject({ kcal: 450, weightKg: 80 });
  });

  it('a workout logged on a past day uses the weight of that day, not a later one', async () => {
    const past = shiftDay(today(), -3);
    await weigh(90, { day: shiftDay(today(), -5) });
    await weigh(70);
    ctx.ai.nextNutrition = workout('Vélo', 60, 8);
    // Logged from the view of three days ago: 90 kg then, although the scale says 70 today.
    expect(await log('une heure de vélo', { day: past })).toMatchObject({ day: past, data: { kcal: 720, weightKg: 90 } });
    expect((await log('une heure de vélo')).data).toMatchObject({ kcal: 560, weightKg: 70 });
  });

  it('keeps the calories the note itself gives, and assumes half an hour when no duration is said', async () => {
    ctx.ai.nextNutrition = workout('Running', 32, 9.8, { kcal: 410 });
    // Given by the capture, so not an estimate: MET 0, and the card will not recompute them.
    expect((await log('footing, 410 kcal à la montre')).data).toMatchObject({ kcal: 410, minutes: 32, met: 0 });
    ctx.ai.nextNutrition = workout('Padel', null, null);
    expect((await log('padel ce matin')).data).toMatchObject({ minutes: 30, met: 5, kcal: 188 });
  });

  it('calories typed by hand stay as typed when the entry is saved and reopened', async () => {
    ctx.ai.nextNutrition = workout('Vélo', 45, 7.5);
    const entry = await confirm((await log('45 min de vélo')).id);
    // The card sends MET 0 with calories set by hand: they no longer follow the duration.
    const res = await call('PATCH', `/api/nutrition/entries/${entry.id}`, { data: { ...entry.data, kcal: 500, met: 0 } });
    expect(res.json().nutrition.data).toMatchObject({ kcal: 500, met: 0, minutes: 45 });
    expect((await day()).totals.burned).toBe(500);
  });

  it('the goal must be a plausible number', async () => {
    for (const kcalGoal of [100, 20_000, 2000.5, '2000']) {
      expect((await call('PUT', '/api/nutrition/settings', { kcalGoal })).statusCode).toBe(400);
    }
    expect((await call('GET', '/api/nutrition/settings')).json()).toEqual({ kcalGoal: 2000, goalSet: false });
  });
});

describe('weight', () => {
  it('typed by hand, it counts at once and shows as the current weight', async () => {
    const res = await weigh(78.44);
    expect(res.json().nutrition).toMatchObject({ type: 'weight', status: 'confirmed', source: 'manual', title: '78.4 kg', data: { kg: 78.4 } });
    expect((await day()).weight).toEqual({ kg: 78.4, day: today() });
  });

  it('a retry stores it once; an impossible weight or a future day is refused', async () => {
    const clientId = newClientId();
    const first = await weigh(78.4, { clientId });
    const again = await weigh(78.4, { clientId });
    expect(again.statusCode).toBe(200);
    expect(again.json().nutrition.id).toBe(first.json().nutrition.id);
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(1);
    expect((await weigh(7)).statusCode).toBe(400);
    expect((await weigh(78, { day: shiftDay(today(), 2) })).statusCode).toBe(400);
  });

  it('a dictated weight can be corrected before it counts', async () => {
    ctx.ai.nextNutrition = weight(87.4);
    const entry = await log('je pèse 87,4');
    const saved = await confirm(entry.id, { data: { kg: 78.4 } });
    expect(saved).toMatchObject({ title: '78.4 kg', data: { kg: 78.4 } });
  });
});

describe('history, for the charts', () => {
  it('gives one line per day with something confirmed: energy, macros, sport, last weight', async () => {
    const d1 = shiftDay(today(), -2);
    const d2 = shiftDay(today(), -1);
    ctx.ai.nextNutrition = meal([food('riz', 'riz blanc cuit', 200, 130)]);
    await confirm((await log('riz', { day: d1 })).id);
    await confirm((await log('riz encore', { day: d1 })).id);
    await confirm((await log('riz', { day: d2 })).id);
    await log('riz non validé', { day: d2 });
    ctx.ai.nextNutrition = workout('Running', 30, 9.8);
    await confirm((await log('footing', { day: d2 })).id);
    await weigh(79, { day: d1 });
    await weigh(78.6, { day: d1 });

    const res = await call('GET', `/api/nutrition/history?from=${shiftDay(today(), -29)}&to=${today()}`);
    const history = res.json() as NutritionHistory;
    expect(history.days.map((d) => d.day)).toEqual([d1, d2]);
    expect(history.days[0]).toMatchObject({ kcal: 620, meals: 2, workouts: 0, burned: 0, weightKg: 78.6 });
    expect(history.days[1]).toMatchObject({ kcal: 310, meals: 1, workouts: 1, weightKg: null });
    expect(history.days[1]!.burned).toBeGreaterThan(300);
    expect(history.days[0]!.carbs).toBeGreaterThan(100);
  });

  it('refuses a period that is upside down or too long', async () => {
    expect((await call('GET', `/api/nutrition/history?from=${today()}&to=${shiftDay(today(), -1)}`)).statusCode).toBe(400);
    expect((await call('GET', `/api/nutrition/history?from=2020-01-01&to=${today()}`)).statusCode).toBe(400);
    expect((await call('GET', '/api/nutrition/history?from=2026-02-30&to=2026-03-01')).statusCode).toBe(400);
  });
});

describe('editing and deleting', () => {
  it('a confirmed entry can still be edited, and deleted for good', async () => {
    const entry = await confirm((await log('une banane')).id);
    const [banana] = (entry.data as MealData).items;
    const patched = await call('PATCH', `/api/nutrition/entries/${entry.id}`, { data: { slot: 'breakfast', items: [{ ...banana!, grams: 60, kcal: 53 }] } });
    expect(patched.json().nutrition).toMatchObject({ status: 'confirmed', data: { slot: 'breakfast' } });
    expect((await day()).totals.eaten.kcal).toBe(53);

    expect((await call('DELETE', `/api/nutrition/entries/${entry.id}`)).json()).toEqual({ deleted: true });
    expect((await call('DELETE', `/api/nutrition/entries/${entry.id}`)).json()).toEqual({ deleted: true });
    expect((await day()).entries).toEqual([]);
    expect(await ctx.db.select().from(deletedCaptures)).toHaveLength(1);
    expect((await call('GET', `/api/nutrition/entries/${entry.id}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/nutrition/entries/${newClientId()}`)).statusCode).toBe(404);
  });

  it('what is said is read or refused, never stored half-understood', async () => {
    ctx.ai.nextNutrition = notNutrition();
    const none = await call('POST', '/api/nutrition/entries', { clientId: newClientId(), text: 'Rappeler le plombier' });
    expect(none.statusCode).toBe(422);
    expect(none.json().error).toBe('not_nutrition');
    ctx.ai.failNutrition = true;
    expect((await call('POST', '/api/nutrition/entries', { clientId: newClientId(), text: 'une banane' })).statusCode).toBe(503);
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(0);
    // A sentence and a weight at once, or neither: not a valid request.
    expect((await call('POST', '/api/nutrition/entries', { clientId: newClientId(), text: 'x', weightKg: 80 })).statusCode).toBe(400);
    expect((await call('POST', '/api/nutrition/entries', { clientId: newClientId() })).statusCode).toBe(400);
  });

  it('foods can be read from a few words, to add to a meal, without storing anything', async () => {
    ctx.ai.nextNutrition = meal([food('yaourt', 'yaourt nature', 125, 60)]);
    const res = await call('POST', '/api/nutrition/estimate', { text: 'un yaourt nature' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ name: 'yaourt', grams: 125, source: 'ciqual' });
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(0);
    ctx.ai.nextNutrition = notNutrition();
    expect((await call('POST', '/api/nutrition/estimate', { text: 'le plombier' })).statusCode).toBe(422);
  });

  it('another account sees, edits and deletes nothing of it', async () => {
    const entry = await confirm((await log('une banane')).id);
    await createUser(ctx.db, 'other@example.com');
    const stranger = await login(ctx.app, 'other@example.com');
    expect((await day(today(), stranger)).entries).toEqual([]);
    expect((await call('GET', `/api/nutrition/entries/${entry.id}`, undefined, stranger)).statusCode).toBe(404);
    expect((await call('PATCH', `/api/nutrition/entries/${entry.id}`, { title: 'Mine now' }, stranger)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/nutrition/entries/${entry.id}`, undefined, stranger)).statusCode).toBe(404);
    expect((await call('GET', `/api/nutrition/entries/${entry.id}/photo`, undefined, stranger)).statusCode).toBe(404);
    expect((await day()).entries).toHaveLength(1);
    expect((await call('GET', `/api/nutrition/day?day=${today()}`, undefined, 'bc_session=nope')).statusCode).toBe(401);
  });
});

describe('photo', () => {
  it('a photo alone is enough: a meal to confirm, with its thumbnail', async () => {
    const res = await photo();
    expect(res.statusCode).toBe(201);
    const entry = res.json().nutrition as NutritionEntry;
    expect(entry).toMatchObject({ type: 'meal', status: 'proposed', source: 'photo', hasPhoto: true, originalText: 'A red apple on a table.' });
    expect((entry.data as MealData).items[0]).toMatchObject({ name: 'apple', grams: 150, source: 'ciqual' });
    expect(ctx.ai.photoCalls[0]).toMatchObject({ caption: '', mimeType: 'image/jpeg', timeZone: ZONE });

    const picture = await call('GET', `/api/nutrition/entries/${entry.id}/photo`);
    expect(picture.statusCode).toBe(200);
    expect(picture.headers['content-type']).toBe('image/jpeg');
    expect(picture.headers['cache-control']).toContain('private');
    expect(Buffer.compare(picture.rawPayload, Buffer.from(JPEG))).toBe(0);
    expect(await ctx.db.select().from(captures)).toHaveLength(0);
  });

  it('the sentence that goes with it reaches the model and is kept', async () => {
    const res = await photo({ caption: "J'en ai mangé la moitié" });
    expect(ctx.ai.photoCalls[0]!.caption).toBe("J'en ai mangé la moitié");
    expect(res.json().nutrition.originalText).toBe("J'en ai mangé la moitié\nA red apple on a table.");
  });

  it('a retry is not analysed twice, and a deleted one does not come back', async () => {
    const clientId = newClientId();
    const first = await photo({ clientId });
    const again = await photo({ clientId });
    expect(again.statusCode).toBe(200);
    expect(again.json().nutrition.id).toBe(first.json().nutrition.id);
    expect(ctx.ai.photoCalls).toHaveLength(1);
    await call('DELETE', `/api/nutrition/entries/${first.json().nutrition.id}`);
    expect((await photo({ clientId })).statusCode).toBe(410);
    expect(await ctx.db.select().from(nutritionPhotos)).toHaveLength(0);
  });

  it('a scale or a sports screen is read too', async () => {
    ctx.ai.nextPhoto = { ...weight(78.4), description: 'A bathroom scale showing 78.4 kg.' };
    expect((await photo()).json().nutrition).toMatchObject({ type: 'weight', data: { kg: 78.4 } });
    ctx.ai.nextPhoto = { ...workout('Running', 42, 9.8, { kcal: 512 }), description: 'A watch summary.' };
    expect((await photo()).json().nutrition).toMatchObject({ type: 'workout', data: { minutes: 42, kcal: 512, met: 0 } });
  });

  it('anything else becomes a note with what the picture says, and stays a note', async () => {
    ctx.ai.nextPhoto = notNutrition({ description: 'A whiteboard.', text: 'Roadmap Q1: onboarding, pricing page' });
    ctx.ai.nextClassification = { category: 'projects', title: 'Roadmap Q1', intent: 'meal' };
    const res = await photo({ caption: 'Tableau de la réunion' });
    expect(res.statusCode).toBe(201);
    expect(res.json().capture).toMatchObject({ kind: 'text', text: 'Tableau de la réunion\n\nRoadmap Q1: onboarding, pricing page', category: 'projects', classificationStatus: 'done' });
    expect(res.json().nutrition).toBeUndefined();
    expect(ctx.ai.nutritionCalls).toHaveLength(0);
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(0);
    expect(await ctx.db.select().from(nutritionPhotos)).toHaveLength(0);

    // No text in it: the description stands in.
    ctx.ai.nextPhoto = notNutrition({ description: 'A bicycle against a wall.' });
    expect((await photo()).json().capture.text).toBe('Photo: A bicycle against a wall.');
  });

  it('when the picture cannot be read, nothing is stored and the phone knows whether to retry', async () => {
    ctx.ai.failPhoto = true;
    const down = await photo();
    expect(down.statusCode).toBe(503);
    expect(down.json().error).toBe('photo_failed');
    ctx.ai.failPhoto = false;
    ctx.ai.rejectPhoto = 'image could not be decoded';
    const refused = await photo();
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('photo_rejected');
    ctx.ai.rejectPhoto = null;
    ctx.ai.nextPhoto = notNutrition();
    expect((await photo()).statusCode).toBe(422);
    expect(await ctx.db.select().from(nutritionEntries)).toHaveLength(0);
    expect(await ctx.db.select().from(captures)).toHaveLength(0);
  });

  it('only pictures are accepted, whatever the upload claims to be', async () => {
    const notAnImage = await photo({}, new TextEncoder().encode('<script>alert(1)</script>'));
    expect(notAnImage.statusCode).toBe(400);
    expect((await photo({}, null)).statusCode).toBe(400);
    expect(ctx.ai.photoCalls).toHaveLength(0);
    // A thumbnail that is not a picture is dropped; the entry is still saved.
    const res = await photo({}, JPEG, new TextEncoder().encode('not a picture'));
    expect(res.json().nutrition.hasPhoto).toBe(false);
  });
});
