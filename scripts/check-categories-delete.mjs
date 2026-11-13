// Isolated browser proof for deleting captures, managing categories and the calendar hand-off:
// in-memory database, a deterministic stand-in for the model, no Google and no network calls.
//   npm run build && node scripts/check-categories-delete.mjs
// BROWSER_CHANNEL=chrome (or msedge) uses an installed browser when Playwright's own is absent.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { buildApp } from '../dist/server/server/app.js';
import { hashPassword } from '../dist/server/server/auth/password.js';
import { loadConfig } from '../dist/server/server/config.js';
import { openDb } from '../dist/server/server/db/client.js';
import { users } from '../dist/server/server/db/schema.js';

/** Sorts by keyword among the categories it is given, like the real one is told to. */
const fakeAi = {
  available: true,
  async transcribe() {
    throw new Error('no audio in this check');
  },
  async classify({ text, categories }) {
    const has = (id) => categories.some((c) => c.id === id);
    const category = /kin[ée]/i.test(text) && has('sante') ? 'sante' : /temporary/i.test(text) && has('temporary') ? 'temporary' : 'other';
    return { category, title: text.slice(0, 40) };
  },
  async extractEvent({ text }) {
    const asked = /agenda/i.test(text);
    return {
      isEventRequest: asked,
      title: 'Dentiste',
      allDay: false,
      start: '2026-11-17T15:00',
      startTimeZone: null,
      end: null,
      endTimeZone: null,
      location: null,
    };
  },
};

async function main() {
  const { db, close } = await openDb('pglite:memory');
  let app;
  let browser;
  const proofs = {};
  try {
    const password = 'isolated-check-password';
    await db.insert(users).values({ email: 'check@example.com', passwordHash: await hashPassword(password) });
    app = await buildApp({ db, ai: fakeAi, config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'pglite:memory' }), webDir: path.resolve('dist/web') });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Europe/Paris', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    if (!(await page.request.post(`${base}/api/auth/login`, { data: { email: 'check@example.com', password } })).ok()) throw new Error('login');
    const post = async (text) =>
      (await (await page.request.post(`${base}/api/captures`, { data: { clientId: crypto.randomUUID(), kind: 'text', text } })).json()).capture;
    await mkdir('.shots', { recursive: true });

    // 1. A new category, from the app.
    await page.goto(`${base}/?view=categories`);
    await page.getByRole('heading', { name: 'Categories', exact: true }).waitFor();
    await page.locator('.category-new').getByLabel('Name').fill('Santé');
    await page.locator('.category-new').getByLabel('What goes here').fill('Health and body: doctors, physiotherapy, sport, sleep.');
    await page.getByRole('button', { name: 'Add category' }).click();
    await page.getByRole('textbox', { name: 'Name of Santé' }).waitFor();
    await page.locator('.desk-side').getByRole('button', { name: /Santé/ }).waitFor();
    // Other is shown, locked.
    await page.getByRole('region', { name: 'Other' }).getByText('Fixed').waitFor();
    await page.screenshot({ path: '.shots/categories-desktop.png', fullPage: true });

    // 2. The sorting uses it at once.
    const kine = await post('Séance de kiné jeudi à 18 h');
    if (kine.category !== 'sante') throw new Error(`sorted into ${kine.category}`);
    await page.goto(`${base}/?view=everything`);
    await page.getByRole('heading', { name: 'Santé', exact: true }).waitFor();
    await page.locator('section.section[data-cat="sante"]').getByText('Séance de kiné jeudi', { exact: false }).waitFor();
    proofs.newCategorySorted = true;

    // 3. Renaming moves nothing.
    await page.goto(`${base}/?view=categories`);
    const name = page.getByRole('textbox', { name: 'Name of Santé' });
    await name.fill('Health');
    await page.getByRole('region', { name: 'Santé' }).getByRole('button', { name: 'Save' }).click();
    await page.getByRole('textbox', { name: 'Name of Health' }).waitFor();
    const renamed = (await (await page.request.get(`${base}/api/captures/${kine.id}`)).json()).capture;
    if (renamed.category !== 'sante') throw new Error('rename moved the capture');
    proofs.renameMovesNothing = true;

    // 4. Deleting a category archives its captures under Other.
    await page.locator('.category-new').getByLabel('Name').fill('Temporary');
    await page.getByRole('button', { name: 'Add category' }).click();
    await page.getByRole('textbox', { name: 'Name of Temporary' }).waitFor();
    const temp = await post('A temporary note');
    if (temp.category !== 'temporary') throw new Error('temporary not used');
    await page.reload();
    await page.getByRole('region', { name: 'Temporary' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByText('Delete Temporary? Its captures (1 open) are archived and moved to Other.').waitFor();
    await page.getByRole('button', { name: 'Delete category' }).click();
    await page.getByRole('textbox', { name: 'Name of Temporary' }).waitFor({ state: 'detached' });
    const archived = (await (await page.request.get(`${base}/api/captures/${temp.id}`)).json()).capture;
    if (archived.status !== 'archived' || archived.category !== 'other') throw new Error('category deletion did not archive');
    proofs.categoryDeletionArchives = true;

    // 5. Delete a capture from the desktop drawer, with confirmation.
    const doomed = await post('Test capture to delete');
    await page.goto(`${base}/?view=everything&id=${doomed.id}`);
    const drawer = page.getByRole('dialog', { name: 'Capture detail' });
    await drawer.getByRole('button', { name: 'Archive' }).waitFor();
    await drawer.getByRole('button', { name: 'Delete', exact: true }).click();
    await drawer.getByText('Delete for good?').waitFor();
    await page.screenshot({ path: '.shots/drawer-delete-confirm.png' });
    await drawer.getByRole('button', { name: 'Delete', exact: true }).click();
    await drawer.waitFor({ state: 'detached' });
    if ((await page.request.get(`${base}/api/captures/${doomed.id}`)).status() !== 404) throw new Error('not deleted');
    if (await page.getByText('Test capture to delete').count()) throw new Error('still listed');
    proofs.drawerDelete = true;

    // 6. Calendar hand-off: once in Google, the capture leaves. Google itself is stood in for:
    // the card is told it may write, and "creating" the event deletes the capture on the server
    // the way the real confirmation does (tests/calendar-event.test.ts covers that path).
    const dentist = await post('Mets dans mon agenda dentiste mardi à 15 h');
    let created = null;
    await page.route(`**/api/captures/${dentist.id}/event`, async (route) => {
      const method = route.request().method();
      const real = await route.fetch();
      const body = await real.json();
      if (method === 'GET' && !created) return route.fulfill({ json: { ...body, access: 'ready' } });
      if (method === 'POST') {
        await page.request.delete(`${base}/api/captures/${dentist.id}`);
        created = {
          access: 'ready',
          captureDeleted: true,
          event: {
            state: 'created',
            draft: route.request().postDataJSON().draft,
            extraction: 'done',
            lastError: null,
            eventUrl: 'https://www.google.com/calendar/event?eid=check',
            createdInCalendarAt: new Date().toISOString(),
          },
        };
        return route.fulfill({ json: created });
      }
      return route.fulfill({ json: created ?? body });
    });
    await page.goto(`${base}/?view=everything&id=${dentist.id}`);
    await drawer.getByRole('button', { name: 'Add to calendar' }).click();
    await drawer.getByText('In your calendar').waitFor();
    await drawer.getByText('this note is no longer in Brain Capture', { exact: false }).waitFor();
    if (await drawer.getByRole('button', { name: 'Archive' }).count()) throw new Error('actions still offered on a removed capture');
    await page.screenshot({ path: '.shots/drawer-calendar-handoff.png' });
    await drawer.getByRole('button', { name: 'Close detail' }).click();
    await page.getByRole('heading', { name: 'Other', exact: true }).waitFor();
    if (await page.locator('.card').getByText('Mets dans mon agenda').count()) throw new Error('hand-off capture still listed');
    proofs.calendarHandoff = true;

    // 7. Phone: delete from the capture view, next to Archive.
    const phoneOne = await post('Phone test capture');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/history?id=${phoneOne.id}`);
    await page.getByRole('button', { name: 'Archive' }).waitFor();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByText('Delete for good?').waitFor();
    await page.screenshot({ path: '.shots/mobile-delete-confirm.png' });
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('heading', { name: 'History' }).waitFor();
    if ((await page.request.get(`${base}/api/captures/${phoneOne.id}`)).status() !== 404) throw new Error('phone delete');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error('mobile overflow');
    proofs.mobileDelete = true;

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
