// Isolated browser proof for the Nutrition section: in-memory database, a deterministic
// stand-in for the model, no Groq, no Open Food Facts, no network calls.
//   npm run build && node scripts/check-nutrition.mjs
// It seeds a month of history through the app's own import, then drives the real interface on
// a desktop and a phone viewport: a capture recognised as a meal never shows among the notes,
// the card is corrected and confirmed, a photo is sent, "It's a note" and "Log in Nutrition"
// work both ways, the charts draw. Screenshots land in .shots/.
// BROWSER_CHANNEL=chrome (or msedge) uses an installed browser when Playwright's own is absent.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { buildApp } from '../dist/server/server/app.js';
import { hashPassword } from '../dist/server/server/auth/password.js';
import { loadConfig } from '../dist/server/server/config.js';
import { openDb } from '../dist/server/server/db/client.js';
import { users } from '../dist/server/server/db/schema.js';
import { createFoodLookup } from '../dist/server/server/nutrition/foods.js';

const NOTHING = { type: 'none', dayOffset: 0, title: '', slot: null, items: [], activity: null, minutes: null, met: null, kcal: null, kg: null, description: '', text: '' };
const food = (name, nameFr, grams, kcal100, protein100, carbs100, fat100) => ({ name, nameFr, brand: null, grams, kcal100, protein100, carbs100, fat100 });
const FOODS = {
  banane: food('banane', 'banane crue', 120, 89, 1.1, 20, 0.3),
  yaourt: food('yaourt nature', 'yaourt nature', 125, 60, 4, 5, 3),
  poulet: food('poulet rôti', 'poulet filet cuit', 130, 165, 30, 0, 4),
  riz: food('riz', 'riz blanc cuit', 250, 130, 3, 28, 0.5),
  pomme: food('apple', 'pomme crue', 150, 52, 0.3, 12, 0.2),
};

/** Reads by keyword, like the real model is told to, so the check is the same every run. */
const fakeAi = {
  available: true,
  async transcribe() {
    throw new Error('no audio in this check');
  },
  async classify({ text }) {
    const todo = /acheter|penser à|rappeler/i.test(text);
    const intent = todo ? 'note' : /mang|banane|poulet|yaourt/i.test(text) ? 'meal' : /v[ée]lo|couru/i.test(text) ? 'workout' : /p[èe]se/i.test(text) ? 'weight' : 'note';
    return { intent, category: 'lifestyle', title: text.slice(0, 40) };
  },
  async extractEvent() {
    return { isEventRequest: false, title: '', allDay: false, start: null, startTimeZone: null, end: null, endTimeZone: null, location: null };
  },
  async extractNutrition({ text }) {
    if (/p[èe]se/i.test(text)) return { ...NOTHING, type: 'weight', kg: Number(text.match(/(\d+[.,]\d+|\d+)/)?.[1].replace(',', '.')) };
    if (/v[ée]lo/i.test(text)) return { ...NOTHING, type: 'workout', title: 'Vélo 45 min', activity: 'Vélo', minutes: 45, met: 7.5 };
    const items = Object.entries(FOODS)
      .filter(([key]) => new RegExp(key, 'i').test(text))
      .map(([, value]) => value);
    return items.length ? { ...NOTHING, type: 'meal', title: items.map((i) => i.name).join(', '), slot: /midi/i.test(text) ? 'lunch' : null, items } : NOTHING;
  },
  async readPhoto() {
    return { ...NOTHING, type: 'meal', title: 'Apple', slot: 'snack', items: [FOODS.pomme], description: 'A red apple on a wooden table.' };
  },
};

const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
const item = (name, grams, per100, ref) => ({
  name,
  grams,
  kcal: Math.round((per100.kcal * grams) / 100),
  protein: Math.round(per100.protein * grams) / 100,
  carbs: Math.round(per100.carbs * grams) / 100,
  fat: Math.round(per100.fat * grams) / 100,
  per100,
  source: 'ciqual',
  ref,
});

/** A month of plausible days, written as a backup file: seeding goes through the real import. */
function demoBackup() {
  const entries = [];
  const add = (offset, hour, type, title, data) => {
    const at = new Date(`${dayOf(offset)}T${String(hour).padStart(2, '0')}:10:00+01:00`).toISOString();
    entries.push({ id: crypto.randomUUID(), clientId: crypto.randomUUID(), type, status: 'confirmed', source: 'voice', day: dayOf(offset), occurredAt: at, timeZone: 'Europe/Paris', title, originalText: title, data, durationMs: 3000, device: 'android', createdAt: at, updatedAt: at });
  };
  for (let d = -29; d <= -1; d++) {
    if (d % 9 === 0) continue; // A day with nothing logged: the chart shows a gap, not a zero.
    const wave = Math.sin(d * 1.7);
    add(d, 8, 'meal', 'Porridge, banane, café', { slot: 'breakfast', items: [item('Porridge', 250 + Math.round(wave * 40), { kcal: 110, protein: 4.5, carbs: 17, fat: 2.4 }, 'Flocons d’avoine bouillis/cuits à l’eau'), item('Banane', 120, { kcal: 88, protein: 1.1, carbs: 19.7, fat: 0.3 }, 'Banane, chair sans peau, crue')] });
    add(d, 13, 'meal', 'Poulet, riz, haricots verts', { slot: 'lunch', items: [item('Poulet rôti', 150, { kcal: 141, protein: 28, carbs: 0, fat: 3.2 }, 'Poulet, filet sans peau grillé/poêlé'), item('Riz', 220 + Math.round(wave * 60), { kcal: 155, protein: 3.2, carbs: 33.2, fat: 0.7 }, 'Riz blanc, cuit, sans sel ajouté'), item('Haricots verts', 150, { kcal: 29, protein: 1.9, carbs: 3, fat: 0.3 }, 'Haricot vert, cuit')] });
    add(d, 20, 'meal', d % 4 === 0 ? 'Pizza margherita' : 'Saumon, quinoa, salade', {
      slot: 'dinner',
      items: d % 4 === 0 ? [item('Pizza margherita', 380, { kcal: 224, protein: 9.5, carbs: 27, fat: 8.2 }, 'Pizza au fromage ou pizza margherita, préemballée')] : [item('Saumon', 140, { kcal: 205, protein: 22, carbs: 0, fat: 13 }, 'Saumon, cuit, sans précision (aliment moyen)'), item('Quinoa', 200, { kcal: 149, protein: 4.7, carbs: 27.9, fat: 1.1 }, 'Quinoa, bouilli/cuit à l’eau, sans sel ajouté')],
    });
    if (d % 3 === 0) add(d, 18, 'workout', 'Vélo 45 min', { activity: 'Vélo', minutes: 45, met: 7.5, kcal: 440, weightKg: 78 });
    if (d % 2 === 0) {
      const kg = Math.round((79.6 + d * -0.045 + wave * 0.25) * 10) / 10;
      add(d, 7, 'weight', `${kg} kg`, { kg });
    }
  }
  add(0, 8, 'meal', 'Porridge, banane, café', { slot: 'breakfast', items: [item('Porridge', 250, { kcal: 110, protein: 4.5, carbs: 17, fat: 2.4 }, 'Flocons d’avoine bouillis/cuits à l’eau'), item('Banane', 120, { kcal: 88, protein: 1.1, carbs: 19.7, fat: 0.3 }, 'Banane, chair sans peau, crue')] });
  add(0, 7, 'weight', '78.4 kg', { kg: 78.4 });
  return { format: 'brain-capture-export', version: 1, exportedAt: new Date().toISOString(), captures: [], nutrition: { entries, settings: { kcalGoal: 2200 } } };
}

async function main() {
  const { db, close } = await openDb('pglite:memory');
  let app;
  let browser;
  const proofs = {};
  try {
    const password = 'isolated-check-password';
    await db.insert(users).values({ email: 'check@example.com', passwordHash: await hashPassword(password) });
    app = await buildApp({ db, ai: fakeAi, foods: createFoodLookup({ fetchImpl: null }), config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'pglite:memory' }), webDir: path.resolve('dist/web') });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Europe/Paris', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await page.goto(base);
    if (!(await page.request.post(`${base}/api/auth/login`, { data: { email: 'check@example.com', password } })).ok()) throw new Error('login');
    const json = async (url) => (await page.request.get(`${base}${url}`)).json();
    const notes = async () => (await json('/api/captures?status=all')).captures;
    const today = dayOf(0);
    const dayData = () => json(`/api/nutrition/day?day=${today}&timeZone=Europe/Paris`);
    await mkdir('.shots', { recursive: true });

    const seeded = await (await page.request.post(`${base}/api/import`, { data: demoBackup() })).json();
    if (!seeded.nutrition?.inserted) throw new Error('seed');
    proofs.seededEntries = seeded.nutrition.inserted;

    // 1. Desktop: a meal typed in the quick bar is read as a meal, not saved as a note.
    await page.goto(`${base}/?view=everything`);
    await page.getByLabel('Quick capture').fill("j'ai mangé une banane et un yaourt");
    await page.getByLabel('Quick capture').press('Enter');
    await page.getByText('Read as a meal', { exact: false }).waitFor();
    await page.getByLabel('Quick capture').fill('acheter des bananes');
    await page.getByLabel('Quick capture').press('Enter');
    await page.getByText('Saved to', { exact: false }).waitFor();
    const afterBar = await notes();
    if (afterBar.length !== 1 || afterBar[0].text !== 'acheter des bananes') throw new Error(`notes after the bar: ${JSON.stringify(afterBar.map((n) => n.text))}`);
    proofs.mealIsNotANote = true;
    proofs.shoppingListIsANote = true;

    // 2. The section: the entry waits under "To confirm", and counts only once added.
    await page.locator('.desk-side').getByRole('button', { name: /Nutrition/ }).click();
    await page.getByRole('heading', { name: 'Nutrition', exact: true }).waitFor();
    const pending = page.getByRole('region', { name: /^Meal: banane/ });
    await pending.getByText('To confirm').waitFor();
    await pending.getByText('Ciqual · Banane, chair sans peau, crue').waitFor();
    const before = (await dayData()).totals.eaten.kcal;
    // Correct a quantity: the calories follow from the table's values per 100 g.
    await pending.getByLabel('Quantity').first().fill('240');
    await pending.getByText(/^\d+ kcal$/).first().waitFor();
    await page.screenshot({ path: '.shots/nutrition-desktop-day.png', fullPage: true });
    await pending.getByRole('button', { name: 'Add to my day' }).click();
    await page.getByRole('button', { name: /banane, yaourt nature/ }).waitFor();
    const after = await dayData();
    if (after.pending.length !== 0) throw new Error('still pending after the tap');
    if (after.totals.eaten.kcal <= before + 200) throw new Error(`totals did not follow the edit: ${before} → ${after.totals.eaten.kcal}`);
    proofs.confirmedAndCounted = { before, after: after.totals.eaten.kcal };

    // 3. A workout and a weight typed in the section; the goal can be changed.
    await page.getByLabel('Log a meal or a workout').fill('45 min de vélo');
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    const ride = page.getByRole('region', { name: /^Workout: Vélo/ });
    await ride.getByRole('button', { name: 'Add to my day' }).click();
    await page.getByRole('button', { name: /Vélo 45 min/ }).waitFor();
    await page.getByLabel('Weight', { exact: true }).fill('78,2');
    await page.locator('.nut-quick-weight').getByRole('button', { name: 'Save' }).click();
    await page.locator('.nut-row').filter({ hasText: '78.2 kg' }).waitFor();
    await page.getByRole('button', { name: 'Change the daily goal' }).click();
    await page.getByLabel('Daily goal (kcal)').fill('2300');
    await page.locator('.nut-goal-form').getByRole('button', { name: 'Save' }).click();
    await page.locator('.nut-stats').getByText('2,300').waitFor();
    const balanced = (await dayData()).totals;
    if (balanced.goal !== 2300 || balanced.burned <= 0 || balanced.remaining !== 2300 - balanced.eaten.kcal + balanced.burned) throw new Error('balance');
    proofs.balance = balanced;
    await page.screenshot({ path: '.shots/nutrition-desktop-day-confirmed.png' });

    // 4. An entry is edited and deleted from the day.
    await page.getByRole('button', { name: /Vélo 45 min/ }).click();
    const rideCard = page.getByRole('region', { name: /^Workout: Vélo/ });
    await rideCard.getByLabel('Duration').fill('60');
    await rideCard.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('60 min', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: /Vélo 45 min/ }).click();
    await page.getByRole('region', { name: /^Workout: Vélo/ }).getByRole('button', { name: 'Delete this entry' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: /Vélo 45 min/ }).waitFor({ state: 'detached' });
    if ((await dayData()).totals.burned !== 0) throw new Error('deleted workout still counted');
    proofs.editAndDelete = true;

    // 5. Trends: the three charts, drawn from the month of history.
    await page.getByRole('button', { name: 'Trends', exact: true }).click();
    await page.getByRole('heading', { name: 'Calories eaten per day' }).waitFor();
    await page.locator('.chart-bar').first().waitFor();
    const bars = await page.locator('.chart-bar').count();
    const dots = await page.locator('.chart-dot').count();
    const segments = await page.locator('.macro-bar span').count();
    if (bars < 20 || dots < 10 || segments !== 3) throw new Error(`charts: ${bars} bars, ${dots} weight points, ${segments} macro segments`);
    await page.locator('.chart').first().hover({ position: { x: 300, y: 120 } });
    await page.locator('.chart-tip').getByText('kcal eaten', { exact: false }).waitFor();
    await page.screenshot({ path: '.shots/nutrition-desktop-trends.png', fullPage: true });
    await page.getByRole('button', { name: 'Show the table' }).click();
    await page.getByRole('columnheader', { name: 'Balance' }).waitFor();
    await page.getByRole('button', { name: '7 days' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chart-bar').length <= 7);
    proofs.charts = { bars, weightPoints: dots, macroSegments: segments };

    // 6. Phone: a photo alone is enough. It is read, shown as a card with its thumbnail, added.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/capture`);
    await page.getByRole('button', { name: 'Photo' }).click();
    await page.screenshot({ path: '.shots/nutrition-mobile-photo-sheet.png' });
    const picture = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 190, g: 40, b: 40 } } }).jpeg().toBuffer();
    await page.getByLabel('Choose from gallery').setInputFiles({ name: 'apple.jpg', mimeType: 'image/jpeg', buffer: picture });
    await page.getByAltText('Selected photo').waitFor();
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Understood as a meal').waitFor();
    const photoCard = page.getByRole('region', { name: /^Meal: Apple/ });
    await photoCard.locator('img.nut-photo').waitFor();
    const thumbnail = await photoCard.locator('img.nut-photo').evaluate(async (img) => {
      await img.decode().catch(() => undefined);
      return { width: img.naturalWidth, height: img.naturalHeight };
    });
    // The phone sent a 1600 px picture: what is kept and served is the 320 px thumbnail.
    if (thumbnail.width !== 320 || thumbnail.height !== 240) throw new Error(`thumbnail not served, or not resized: ${JSON.stringify(thumbnail)}`);
    proofs.thumbnail = thumbnail;
    await page.screenshot({ path: '.shots/nutrition-mobile-card.png' });
    await photoCard.getByRole('button', { name: 'Add to my day' }).click();
    await page.getByText('Added to Nutrition').waitFor();
    proofs.photo = true;

    // 7. Phone: the Nutrition screen.
    await page.getByRole('button', { name: 'Nutrition' }).last().click();
    await page.getByRole('heading', { name: 'Nutrition', exact: true }).waitFor();
    await page.getByRole('button', { name: /Apple/ }).waitFor();
    await page.locator('img.nut-thumb').first().waitFor();
    await page.screenshot({ path: '.shots/nutrition-mobile-day.png', fullPage: true });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('mobile overflow (day)');
    await page.getByRole('button', { name: 'Trends', exact: true }).click();
    await page.locator('.chart-bar').first().waitFor();
    await page.screenshot({ path: '.shots/nutrition-mobile-trends.png', fullPage: true });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('mobile overflow (trends)');
    proofs.mobile = true;

    // 8. "It's a note": the detection was wrong, the entry becomes a note and leaves Nutrition.
    await page.goto(`${base}/capture`);
    await page.getByRole('button', { name: 'Text' }).click();
    await page.getByRole('textbox', { name: 'Note' }).fill('Poulet au citron, recette à tester samedi');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Understood as a meal').waitFor();
    await page.getByRole('button', { name: 'It’s a note' }).click();
    await page.getByText('Saved', { exact: false }).first().waitFor();
    await page.getByRole('heading', { name: /Poulet au citron/ }).waitFor();
    const afterNote = await notes();
    if (!afterNote.some((n) => n.text === 'Poulet au citron, recette à tester samedi')) throw new Error('note missing after "It’s a note"');
    if ((await dayData()).pending.length !== 0) throw new Error('entry still in Nutrition after "It’s a note"');
    proofs.itsANote = true;

    // 9. And back: "Log in Nutrition" on a note.
    await page.getByRole('button', { name: 'Log in Nutrition' }).click();
    await page.getByText('Understood as a meal').waitFor();
    if ((await notes()).some((n) => n.text.startsWith('Poulet au citron'))) throw new Error('note still listed after "Log in Nutrition"');
    proofs.logInNutrition = true;

    if (errors.length) throw new Error(errors.join('\n'));
    console.log(JSON.stringify({ ...proofs, consoleErrors: errors }, null, 2));
  } finally {
    await browser?.close();
    await app?.close();
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
