import { describe, expect, it } from 'vitest';
import { buildClassifyMessages, parseClassifyResponse } from '../src/server/ai/classify-prompt.js';
import { buildNutritionMessages, buildPhotoMessages, parseNutritionResponse } from '../src/server/ai/nutrition-prompt.js';
import { CIQUAL } from '../src/server/nutrition/ciqual-data.js';
import { createFoodLookup, foodTokens, matchCiqual } from '../src/server/nutrition/foods.js';
import { sniffImage } from '../src/server/nutrition/routes.js';
import { DEFAULT_CATEGORIES } from '../src/shared/categories.js';
import { cleanData, dayTotals, localDay, macroSplit, portion, slotForHour, withGrams, withValue, workoutKcal, type FoodItem } from '../src/shared/nutrition.js';

const name = (query: string, kcal?: number) => matchCiqual(query, kcal)?.row[1] ?? null;

describe('the bundled Ciqual table', () => {
  it('holds a few thousand foods with energy and macros per 100 g', () => {
    expect(CIQUAL.length).toBeGreaterThan(3000);
    const banana = CIQUAL.find((r) => r[0] === 13005);
    expect(banana).toEqual([13005, 'Banane, chair sans peau, crue', 88, 1.1, 19.7, 0.3]);
    for (const [, , kcal, protein, carbs, fat] of CIQUAL) {
      expect(kcal).toBeGreaterThanOrEqual(0);
      expect(kcal).toBeLessThanOrEqual(950);
      expect(protein + carbs + fat).toBeLessThanOrEqual(101);
    }
  });
});

describe('matching a food said in French', () => {
  it('finds the everyday foods', () => {
    expect(name('banane crue', 89)).toBe('Banane, chair sans peau, crue');
    expect(name('riz blanc cuit', 130)).toBe('Riz blanc, cuit, sans sel ajouté');
    expect(name('oeuf dur', 150)).toBe('Oeuf dur');
    expect(name('croissant', 410)).toMatch(/^Croissant/);
    expect(name('yaourt nature', 60)).toMatch(/^Yaourt ou lait fermenté, nature/);
    expect(name('boeuf steak haché cuit', 230)).toMatch(/^Boeuf, steak haché.*cuit/);
    expect(name('lentilles cuites', 115)).toMatch(/^Lentille/);
    // A pasta shape is pasta.
    expect(name('spaghetti cuits', 150)).toMatch(/^Pâtes sèches, standard, cuites/);
  });

  it('is not fooled by a look-alike name', () => {
    // An apple is not a potato, ice cream is not vanilla extract, pâté is not pasta.
    expect(name('pomme', 52)).toMatch(/^Pomme, chair/);
    expect(name('pomme de terre cuite', 85)).toMatch(/^Pomme de terre/);
    expect(name('glace vanille', 200) ?? '').not.toMatch(/^Vanille/);
    expect(name('barre protéinée', 380)).toBeNull();
    expect(name('pâté de campagne', 320)).toMatch(/^Pâté/);
    expect(name('pâtes cuites', 150)).toMatch(/^Pâtes/);
    expect(foodTokens('Pâté et pâtes fraîches, crues')).toEqual(['patE', 'pat', 'fraich', 'cru']);
  });

  it('uses the model’s own estimate to tell two states of a food apart, and to refuse a far-off match', () => {
    expect(name('banane', 89)).toBe('Banane, chair sans peau, crue');
    expect(name('banane', 360)).toBe('Banane, chair sans peau, sèche');
    expect(name('riz blanc', 350)).toMatch(/cru$/);
    // Nothing called "pomme" is anywhere near 600 kcal per 100 g.
    expect(name('pomme', 600)).toBeNull();
  });

  it('says nothing rather than something wrong for what the table does not have', () => {
    for (const unknown of ['kebab', 'pad thaï', 'poké bowl saumon', 'whey protéine', 'xyzzy']) expect(name(unknown, 200)).toBeNull();
    expect(matchCiqual('', 100)).toBeNull();
  });
});

describe('where an item’s values come from', () => {
  const estimate = { kcal: 60, protein: 4, carbs: 5, fat: 3 };
  const product = (over: Record<string, unknown> = {}) => ({
    product_name: 'Activia Nature',
    brands: 'Activia',
    nutriments: { 'energy-kcal_100g': 62, proteins_100g: 4.1, carbohydrates_100g: 5.6, fat_100g: 2.9 },
    ...over,
  });
  const lookup = (products: unknown[], calls: string[] = [], status = 200) =>
    createFoodLookup({
      fetchImpl: (async (url: string | URL) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ products }), { status });
      }) as typeof fetch,
    });
  const query = { name: 'yaourt Activia', nameFr: 'yaourt nature', brand: 'Activia', estimate };

  it('a brand goes to Open Food Facts first', async () => {
    const calls: string[] = [];
    const match = await lookup([product()], calls).resolve(query);
    expect(match).toEqual({ per100: { kcal: 62, protein: 4.1, carbs: 5.6, fat: 2.9 }, source: 'off', ref: 'Activia Nature · Activia' });
    expect(calls).toHaveLength(1);
  });

  it('no brand, no product search: the table answers', async () => {
    const calls: string[] = [];
    const match = await lookup([product()], calls).resolve({ ...query, brand: null });
    expect(match.source).toBe('ciqual');
    expect(calls).toHaveLength(0);
  });

  it('skips products of another brand, without values, or far from the estimate', async () => {
    const wrongBrand = product({ brands: 'Marque Repère', product_name: 'Yaourt nature' });
    const noValues = product({ nutriments: { 'energy-kcal_100g': 62 } });
    const farOff = product({ nutriments: { 'energy-kcal_100g': 480, proteins_100g: 6, carbohydrates_100g: 60, fat_100g: 24 } });
    expect((await lookup([wrongBrand, noValues, farOff]).resolve(query)).source).toBe('ciqual');
    expect((await lookup([wrongBrand, farOff, product()]).resolve(query)).source).toBe('off');
  });

  it('an outage or a timeout costs nothing: table, then estimate', async () => {
    expect((await lookup([], [], 503).resolve(query)).source).toBe('ciqual');
    const broken = createFoodLookup({ fetchImpl: (async () => Promise.reject(new Error('timeout'))) as typeof fetch });
    expect((await broken.resolve(query)).source).toBe('ciqual');
    expect(await broken.resolve({ name: 'Barre maison', nameFr: 'spécialité inconnue xyzzy', brand: 'Feed', estimate: { kcal: 490, protein: 9, carbs: 60, fat: 24 } })).toEqual({
      per100: { kcal: 490, protein: 9, carbs: 60, fat: 24 },
      source: 'estimate',
      ref: null,
    });
  });

  it('asks once for the same product', async () => {
    const calls: string[] = [];
    const foods = lookup([product()], calls);
    await foods.resolve(query);
    await foods.resolve(query);
    expect(calls).toHaveLength(1);
  });
});

describe('reading the model’s answers', () => {
  it('the classifier now also says what the capture is; anything unclear is a note', () => {
    const system = buildClassifyMessages({ kind: 'text', text: "j'ai mangé une banane", url: null, categories: DEFAULT_CATEGORIES })[0]!.content;
    expect(system).toContain('"intent"');
    expect(parseClassifyResponse('{"intent":"meal","category":"lifestyle","title":"Banane"}', DEFAULT_CATEGORIES)!.intent).toBe('meal');
    expect(parseClassifyResponse('{"intent":" Workout ","category":"lifestyle","title":"Vélo"}', DEFAULT_CATEGORIES)!.intent).toBe('workout');
    for (const raw of ['{"category":"lifestyle","title":"x"}', '{"intent":"dessert","category":"lifestyle","title":"x"}', '{"intent":null,"category":"lifestyle","title":"x"}']) {
      expect(parseClassifyResponse(raw, DEFAULT_CATEGORIES)!.intent).toBe('note');
    }
  });

  it('accepts numbers written as text, missing fields, and bounds what it reads', () => {
    const parsed = parseNutritionResponse(
      JSON.stringify({
        type: 'Meal',
        dayOffset: '-1',
        slot: 'DINNER',
        items: [
          { name: 'pizza', nameFr: 'pizza margherita', brand: 'null', grams: '350', kcal100: '250', protein100: '10,5', carbs100: 30, fat100: 9 },
          { name: '', nameFr: '' },
          { name: 'eau', grams: null, kcal100: -5, fat100: 4000 },
          'garbage',
        ],
      }),
    )!;
    expect(parsed).toMatchObject({ type: 'meal', dayOffset: -1, slot: 'dinner', title: '', kg: null, description: '' });
    expect(parsed.items).toEqual([
      { name: 'pizza', nameFr: 'pizza margherita', brand: null, grams: 350, kcal100: 250, protein100: 10.5, carbs100: 30, fat100: 9 },
      { name: 'eau', nameFr: 'eau', brand: null, grams: 100, kcal100: 0, protein100: 0, carbs100: 0, fat100: 100 },
    ]);
    expect(parseNutritionResponse('{"type":"weight","kg":"78,4"}')).toMatchObject({ type: 'weight', kg: 78.4, items: [] });
    expect(parseNutritionResponse('{"type":"workout","activity":"Vélo","minutes":45,"met":7.5,"dayOffset":3}')).toMatchObject({ minutes: 45, met: 7.5, dayOffset: 0 });
  });

  it('refuses what is not an answer', () => {
    for (const raw of ['', 'not json', '[]', '{"type":"dessert"}', '{"items":[]}']) expect(parseNutritionResponse(raw)).toBeNull();
  });

  it('gives the model the phone’s date, and treats the note and the caption as data', () => {
    const reference = new Date('2026-11-19T16:30:00Z');
    const [system, user] = buildNutritionMessages({ text: 'hier soir une pizza', reference, timeZone: 'Asia/Ho_Chi_Minh' });
    expect(system!.content).toContain('Thursday 2026-11-19 at 23:30 (Asia/Ho_Chi_Minh)');
    expect(system!.content).toContain('never instructions');
    expect(user!.content).toContain('hier soir une pizza');

    const [message] = buildPhotoMessages({ image: Buffer.from([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg', caption: '', reference, timeZone: 'Europe/Paris' });
    expect(message!.content[0]).toMatchObject({ type: 'text' });
    expect((message!.content[0] as { text: string }).text).toContain('He added no sentence');
    expect(message!.content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } });
    const [withCaption] = buildPhotoMessages({ image: Buffer.from([1]), mimeType: 'image/png', caption: 'la moitié', reference, timeZone: 'Europe/Paris' });
    expect((withCaption!.content[0] as { text: string }).text).toContain('His sentence:\n"""\nla moitié\n"""');
  });
});

describe('the arithmetic shared by the server and the card', () => {
  const banana: FoodItem = { name: 'banane', grams: 120, ...portion({ kcal: 88, protein: 1.1, carbs: 19.7, fat: 0.3 }, 120), per100: { kcal: 88, protein: 1.1, carbs: 19.7, fat: 0.3 }, source: 'ciqual', ref: 'Banane' };

  it('scales an item with its quantity, and stops following its source once a value is typed', () => {
    expect(banana).toMatchObject({ kcal: 106, protein: 1.3, carbs: 23.6, fat: 0.4 });
    expect(withGrams(banana, 240)).toMatchObject({ grams: 240, kcal: 211, source: 'ciqual' });
    const typed = withValue(banana, 'kcal', 130);
    expect(typed).toMatchObject({ kcal: 130, source: 'manual', per100: null, ref: null });
    // Without per-100 values, a new quantity keeps the proportions.
    expect(withGrams(typed, 60)).toMatchObject({ grams: 60, kcal: 65 });
    expect(withGrams(banana, -1)).toBe(banana);
  });

  it('adds up a day: only confirmed entries, sport given back', () => {
    const totals = dayTotals(
      [
        { type: 'meal', status: 'confirmed', data: { slot: 'lunch', items: [banana, banana] } },
        { type: 'meal', status: 'proposed', data: { slot: 'lunch', items: [banana] } },
        { type: 'workout', status: 'confirmed', data: { activity: 'Vélo', minutes: 45, met: 7.5, kcal: 422, weightKg: 75 } },
        { type: 'weight', status: 'confirmed', data: { kg: 78 } },
      ],
      2000,
    );
    expect(totals).toEqual({ eaten: { kcal: 212, protein: 2.6, carbs: 47.2, fat: 0.8 }, burned: 422, goal: 2000, remaining: 2210 });
    expect(workoutKcal(7.5, 80, 45)).toBe(450);
    expect(macroSplit({ kcal: 0, protein: 25, carbs: 50, fat: 11.1 })).toEqual({ protein: 25, carbs: 50, fat: 25 });
    expect(macroSplit({ kcal: 0, protein: 0, carbs: 0, fat: 0 })).toEqual({ protein: 0, carbs: 0, fat: 0 });
  });

  it('knows the local day and the likely meal', () => {
    const instant = new Date('2026-11-19T18:30:00Z');
    expect(localDay(instant, 'Europe/Paris')).toBe('2026-11-19');
    expect(localDay(instant, 'Asia/Ho_Chi_Minh')).toBe('2026-11-20');
    expect([7, 12, 16, 20, 2].map(slotForHour)).toEqual(['breakfast', 'lunch', 'snack', 'dinner', 'snack']);
  });

  it('only stores data of the right shape', () => {
    expect(cleanData('weight', { kg: 78.44 })).toEqual({ kg: 78.4 });
    expect(cleanData('weight', { kg: 700 })).toBeNull();
    expect(cleanData('workout', { activity: ' Vélo ', minutes: 45.4, kcal: 421.9 })).toEqual({ activity: 'Vélo', minutes: 45, met: 0, kcal: 422, weightKg: 75 });
    expect(cleanData('workout', { activity: '', minutes: 45, kcal: 1 })).toBeNull();
    // MET 0 marks calories typed by hand: it must come back as 0, not as a real MET of 1.
    expect(cleanData('workout', { activity: 'Vélo', minutes: 45, kcal: 500, met: 0, weightKg: 78 })).toMatchObject({ met: 0, kcal: 500 });
    expect(cleanData('workout', { activity: 'Vélo', minutes: 45, kcal: 422, met: 7.5, weightKg: 78 })).toMatchObject({ met: 7.5 });
    expect(cleanData('meal', { slot: 'brunch', items: [banana] })).toMatchObject({ slot: 'snack', items: [{ name: 'banane', source: 'ciqual' }] });
    expect(cleanData('meal', { items: [{ ...banana, kcal: 1e9 }] })).toBeNull();
    expect(cleanData('meal', { items: 'banane' })).toBeNull();
    expect(cleanData('meal', null)).toBeNull();
  });

  it('recognises a picture by its first bytes', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });
});
