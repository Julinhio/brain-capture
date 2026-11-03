// In-memory app + fake Google transport. Exercises real discovery, aggregation,
// preference endpoints and the built browser UI without any production writes.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { OAuth2Client } from 'google-auth-library';
import { eq } from 'drizzle-orm';
import { buildApp } from '../dist/server/server/app.js';
import { createUnavailableAi } from '../dist/server/server/ai/groq.js';
import { hashPassword } from '../dist/server/server/auth/password.js';
import { loadConfig } from '../dist/server/server/config.js';
import { openDb } from '../dist/server/server/db/client.js';
import { users, calendarConnections } from '../dist/server/server/db/schema.js';
import { CALENDAR_SCOPES, seal } from '../dist/server/server/dashboard/calendar.js';
import { dayWindow } from '../dist/server/server/dashboard/day.js';

async function main() {
  const key = 'cc'.repeat(32);
  const ownerId = randomUUID();
  const { db, close } = await openDb('pglite:memory');
  const day = dayWindow('Europe/Paris').date;
  const calendars = [
    { id: 'lifestyle', summary: 'Lifestyle', accessRole: 'owner', backgroundColor: '#4986e7' },
    { id: 'education', summary: 'Education', accessRole: 'owner', backgroundColor: '#fa573c' },
    { id: 'business', summary: 'Business', accessRole: 'owner', backgroundColor: '#fad165' },
    { id: 'health', summary: 'Health & Fitness', accessRole: 'owner', backgroundColor: '#7bd148' },
    { id: 'holidays', summary: 'Jours fériés', accessRole: 'reader', backgroundColor: '#16a765' },
  ];
  const event = (id, summary, start, end) => ({
    id,
    summary,
    start: { dateTime: `${day}T${start}:00+01:00` },
    end: { dateTime: `${day}T${end}:00+01:00` },
  });
  const entries = {
    lifestyle: [event('same-id', 'Radar Emploi', '15:15', '17:15')],
    education: [
      event('same-id', 'Building with Claude API', '08:30', '10:15'),
      event('learn', 'Learn By Doing', '10:30', '12:15'),
    ],
    business: [event('agency', 'Automata Things', '13:30', '15:00')],
    health: [],
    holidays: [],
  };
  let failEducation = false;
  const original = OAuth2Client.prototype.request;
  OAuth2Client.prototype.request = async ({ url }) => {
    if (url.endsWith('/calendarList')) return { data: { items: calendars } };
    const id = decodeURIComponent(url.match(/calendars\/(.+)\/events/)?.[1] ?? '');
    if (id === 'education' && failEducation) throw new Error('Isolated simulated outage');
    if (!(id in entries)) throw new Error('Unexpected calendar');
    return { data: { items: entries[id] } };
  };
  let app;
  let browser;
  try {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite:memory',
      GOOGLE_CLIENT_ID: 'test',
      GOOGLE_CLIENT_SECRET: 'test',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/calendar/callback',
      CALENDAR_ENCRYPTION_KEY: key,
    });
    await db.insert(users).values({
      id: ownerId,
      email: 'calendar-preview@example.com',
      passwordHash: await hashPassword('isolated-preview-password'),
    });
    await db
      .insert(calendarConnections)
      .values({ ownerId, refreshToken: seal('isolated-fake-token', key), grantedScopes: CALENDAR_SCOPES.join(' ') });
    app = await buildApp({ db, ai: createUnavailableAi(), config, webDir: path.resolve('dist/web') });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
      timezoneId: 'Europe/Paris',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    const login = await context.request.post(base + '/api/auth/login', {
      data: { email: 'calendar-preview@example.com', password: 'isolated-preview-password' },
    });
    if (!login.ok()) throw new Error('Isolated login failed');
    await page.reload();
    await page.getByText('Building with Claude API', { exact: true }).waitFor();
    await page.getByText('Automata Things', { exact: true }).waitFor();
    if (!(await page.locator('.day-stats').innerText()).includes('5 h'))
      throw new Error('Wrong complete-day availability');
    const sources = await page.locator('.calendar-options input:checked').count();
    if (sources !== 4) throw new Error('Not all owned calendars selected');
    if (await page.getByRole('checkbox', { name: 'Jours fériés', exact: true }).isChecked())
      throw new Error('Subscription selected by default');
    const colors = await page
      .locator('.busy-slot')
      .evaluateAll((nodes) => [...new Set(nodes.map((n) => getComputedStyle(n).backgroundColor))]);
    if (colors.length !== 3) throw new Error('Calendar colours lost');
    await mkdir('.shots', { recursive: true });
    await page.screenshot({ path: '.shots/multi-calendar-desktop.jpg', type: 'jpeg', quality: 75 });
    await page.getByRole('checkbox', { name: 'Education', exact: true }).uncheck();
    await page.waitForFunction(() => !document.querySelector('.calendar-option input:disabled'));
    if ((await page.locator('.day-stats').innerText()).includes('5 h'))
      throw new Error('Selection did not update availability');
    if (await page.getByText('Building with Claude API', { exact: true }).count())
      throw new Error('Deselected source remains visible');
    await page.reload();
    await page.locator('.calendar-panel .calendar-freshness').waitFor();
    if (await page.getByRole('checkbox', { name: 'Education', exact: true }).isChecked())
      throw new Error('Selection lost after reload');
    for (const name of ['Lifestyle', 'Business', 'Health & Fitness']) {
      await page.getByRole('checkbox', { name, exact: true }).uncheck();
      await page.waitForFunction(() => !document.querySelector('.calendar-option input:disabled'));
    }
    await page.getByText('Aucun calendrier sélectionné.', { exact: false }).waitFor();
    await page.locator('.brief-appointment').getByText('Choisis les calendriers à inclure', { exact: true }).waitFor();
    if (await page.locator('.day-stats').count()) throw new Error('No-selection claims a free day');
    await page.getByRole('button', { name: 'Tous mes calendriers', exact: true }).click();
    await page.getByText('Building with Claude API', { exact: true }).waitFor();
    failEducation = true;
    await page.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await page.locator('.calendar-incomplete').waitFor();
    if (await page.locator('.day-stats, .day-timeline, .free-windows').count())
      throw new Error('Partial day claims free time');
    await page.getByText('Automata Things', { exact: true }).waitFor();
    await page.screenshot({ path: '.shots/multi-calendar-partial.jpg', type: 'jpeg', quality: 70 });
    failEducation = false;
    await page.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await page.locator('.day-stats').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/?view=today');
    await page.getByText('Building with Claude API', { exact: true }).waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error('Mobile overflow');
    await page.screenshot({ path: '.shots/multi-calendar-mobile.jpg', fullPage: true, type: 'jpeg', quality: 65 });
    await db.update(calendarConnections).set({ grantedScopes: '' }).where(eq(calendarConnections.ownerId, ownerId));
    await page.reload();
    await page.getByRole('button', { name: 'Reconnecter mes calendriers', exact: true }).waitFor();
    if (await page.locator('.day-stats, .free-windows').count()) throw new Error('Legacy scope claims complete day');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(
      JSON.stringify({
        ownedCalendarsIncluded: sources,
        separateCalendarColors: colors.length,
        completeDayFreeMinutes: 300,
        subscriptionExcluded: true,
        selectionSurvivesReload: true,
        emptySelectionNotFreeDay: true,
        partialFailureNoFreeClaim: true,
        legacyGrantRequiresConsent: true,
        mobileNoOverflow: true,
        consoleErrors: errors,
        googleTransport: 'isolated fixture',
        productionWrites: false,
      }),
    );
  } finally {
    OAuth2Client.prototype.request = original;
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
