// Isolated browser proof: in-memory database, fake radar HTTP sources, fixture calendar.
// No production writes, no live credentials and no LLM calls.
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { buildApp } from '../dist/server/server/app.js';
import { createUnavailableAi } from '../dist/server/server/ai/groq.js';
import { hashPassword } from '../dist/server/server/auth/password.js';
import { loadConfig } from '../dist/server/server/config.js';
import { openDb } from '../dist/server/server/db/client.js';
import { captures, users } from '../dist/server/server/db/schema.js';
import { dayWindow } from '../dist/server/server/dashboard/day.js';

async function main() {
  const { db, close } = await openDb('pglite:memory');
  let app;
  let browser;
  const jobsToken = 'j'.repeat(48);
  const agencyToken = 'a'.repeat(48);
  let sourceReads = 0;
  const sources = createServer((req, res) => {
    const kind =
      req.headers.authorization === `Bearer ${jobsToken}`
        ? 'jobs'
        : req.headers.authorization === `Bearer ${agencyToken}`
          ? 'automata'
          : null;
    if (!kind || req.url !== '/integrations/brain-summary.json') {
      res.writeHead(401).end();
      return;
    }
    sourceReads++;
    const segments =
      kind === 'jobs'
        ? [
            { key: 'a_voir', label: 'À voir', value: 124 },
            { key: 'a_tenter', label: 'À tenter', value: 31 },
            { key: 'interessante', label: 'Intéressantes', value: 18 },
            { key: 'postule', label: 'Candidatures', value: 12 },
            { key: 'ecartee', label: 'Écartées', value: 27 },
            { key: 'rejected', label: 'Non retenues par l’IA', value: 2390 },
            { key: 'a_relire', label: 'À relire', value: 4 },
            { key: 'pending', label: 'Tri en attente', value: 60 },
            { key: 'errors', label: 'Erreurs de tri', value: 3 },
          ]
        : [
            { key: 'a_verifier', label: 'À vérifier', value: 56 },
            { key: 'contactee', label: 'Contactées', value: 8 },
            { key: 'audit_propose', label: 'Audit proposé', value: 2 },
            { key: 'audit_fait', label: 'Audit fait', value: 1 },
            { key: 'mission', label: 'Missions', value: 0 },
            { key: 'ecartee', label: 'Écartées', value: 4 },
          ];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        version: 1,
        checkedAt: new Date().toISOString(),
        total: segments.reduce((n, m) => n + m.value, 0),
        new24h: kind === 'jobs' ? 14 : 6,
        segments,
        extra:
          kind === 'jobs'
            ? [
                { key: 'prioritaires', label: 'Prioritaires', value: 9 },
                { key: 'duplicates', label: 'Doublons exclus', value: 150 },
              ]
            : [],
      }),
    );
  });
  await new Promise((resolve) => sources.listen(0, '127.0.0.1', resolve));
  try {
    const sourceUrl = `http://127.0.0.1:${sources.address().port}`;
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite:memory',
      RADAR_JOBS_URL: sourceUrl,
      RADAR_JOBS_TOKEN: jobsToken,
      RADAR_AUTOMATA_URL: sourceUrl,
      RADAR_AUTOMATA_TOKEN: agencyToken,
    });
    await db
      .insert(users)
      .values({ email: 'preview@example.com', passwordHash: await hashPassword('preview-isolated-password') });
    app = await buildApp({ db, ai: createUnavailableAi(), config, webDir: path.resolve('dist/web') });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    // BROWSER_CHANNEL=chrome (or msedge) uses an installed browser when Playwright's own is absent.
    browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
      timezoneId: 'Europe/Paris',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    const login = await page.request.post(`${base}/api/auth/login`, {
      data: { email: 'preview@example.com', password: 'preview-isolated-password' },
    });
    if (!login.ok()) throw new Error('Preview login failed');
    const note = (
      await (
        await page.request.post(`${base}/api/captures`, {
          data: {
            clientId: crypto.randomUUID(),
            kind: 'text',
            text: 'Préparer une démonstration du radar pour Automata.',
          },
        })
      ).json()
    ).capture;
    const window = dayWindow('Europe/Paris');
    await db
      .update(captures)
      .set({
        createdAt: new Date(Date.parse(window.previousStart) + 16 * 3600_000),
        category: 'automata',
        title: 'Une démo du radar pour Automata',
      })
      .where(eq(captures.id, note.id));
    for (const project of [
      {
        name: 'BrainCapture · dashboard',
        intention: 'Relier la journée aux idées et aux projets.',
        state: 'active',
        nextStep: 'Tester le briefing du matin',
        captureId: note.id,
      },
      {
        name: 'LendLoop',
        intention: 'Un petit produit pour pratiquer et préparer une candidature.',
        state: 'upcoming',
        nextStep: 'Clarifier le premier parcours',
      },
      { name: 'CV sur mesure', intention: 'Explorer un produit simple avec paiement.', state: 'idea', nextStep: '' },
    ]) {
      const response = await page.request.post(`${base}/api/projects`, { data: project });
      if (!response.ok()) throw new Error('Project fixture failed');
    }
    await page.reload();
    await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Julien\.$/ }).waitFor();
    await page.locator('.radar-numbers strong').getByText('124', { exact: true }).waitFor();
    await page.getByText('The Google connection must be configured', { exact: false }).waitFor();
    // Calendar display proof is fixture based; OAuth security / API pagination are tested separately.
    const day = window.date;
    await page.route('**/api/calendar/day?*', (route) =>
      route.fulfill({
        json: {
          state: 'ready',
          checkedAt: new Date().toISOString(),
          calendars: [
            { id: 'primary', name: 'Julien', color: '#f0a35b', owned: true, selected: true, loadState: 'ready' },
            { id: 'family', name: 'Famille', color: '#6fb6e8', owned: true, selected: false, loadState: 'off' },
          ],
          events: [
            {
              id: 'training',
              title: 'Formation · API et conversations',
              start: `${day}T09:00:00+01:00`,
              end: `${day}T10:30:00+01:00`,
              allDay: false,
              busy: true,
              url: null,
            },
            {
              id: 'job',
              title: 'Recherche d’emploi',
              start: `${day}T13:30:00+01:00`,
              end: `${day}T15:00:00+01:00`,
              allDay: false,
              busy: true,
              url: null,
            },
            {
              id: 'build',
              title: 'Construction · BrainCapture',
              start: `${day}T16:00:00+01:00`,
              end: `${day}T18:00:00+01:00`,
              allDay: false,
              busy: true,
              url: null,
            },
          ],
        },
      }),
    );
    await page.reload();
    await mkdir('.shots', { recursive: true });
    const toggle = page.getByRole('button', { name: /Calendars and appointments/ });
    // Collapsed by default: counters and timeline visible, calendars and appointments not.
    await page.locator('.day-stats').getByText('appointments & events').waitFor();
    await page.locator('.day-timeline .busy-slot').first().waitFor();
    if ((await toggle.getAttribute('aria-expanded')) !== 'false') throw new Error('My day should start collapsed');
    if (await page.locator('.calendar-panel').getByText('Formation · API et conversations', { exact: true }).count())
      throw new Error('Appointments shown while collapsed');
    if (await page.getByRole('group', { name: 'Included calendars' }).count())
      throw new Error('Calendar choice shown while collapsed');
    // Both radar cards: same number of rows, same height, the left-out job segments nowhere.
    const radar = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.radar-card')];
      return {
        heights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
        rows: cards.map((c) => c.querySelectorAll('.radar-breakdown > div').length),
        barSegments: cards.map((c) => c.querySelectorAll('.radar-stack > span').length),
        jobsText: cards[0]?.textContent ?? '',
      };
    });
    if (radar.rows.join() !== '6,6') throw new Error('Radar rows ' + radar.rows.join());
    if (radar.heights[0] !== radar.heights[1]) throw new Error('Radar heights differ: ' + radar.heights.join());
    for (const gone of ['Not kept by AI', 'Awaiting sorting', 'Sorting errors', 'Priority', 'Duplicates', 'unique offers', '2,390'])
      if (radar.jobsText.includes(gone)) throw new Error('Job Radar still shows ' + gone);
    await page.screenshot({ path: '.shots/today-desktop-collapsed.png', fullPage: true });
    await toggle.click();
    await page.locator('.calendar-panel').getByText('Formation · API et conversations', { exact: true }).waitFor();
    await page.getByRole('group', { name: 'Included calendars' }).waitFor();
    await page.getByText('Free slots', { exact: true }).waitFor();
    await page.screenshot({ path: '.shots/today-desktop-expanded.png', fullPage: true });
    // Remembered on this computer: still open after a reload.
    await page.reload();
    await page.locator('.calendar-panel').getByText('Formation · API et conversations', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Everything', exact: false }).click();
    await page.getByRole('heading', { name: 'Automata', exact: true }).waitFor();
    await page.getByRole('button', { name: 'My projects', exact: true }).click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Projet créé au navigateur');
    await page.getByLabel('State', { exact: true }).selectOption('active');
    await page.getByLabel('Intention', { exact: true }).fill('Vérifier le parcours complet.');
    await page.getByRole('button', { name: 'Save project' }).click();
    const projectButton = page.getByRole('button', { name: 'Projet créé au navigateur', exact: false });
    await projectButton.waitFor();
    await projectButton.click();
    await page.getByLabel('Add a capture').fill('radar');
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await page.getByRole('button', { name: 'Unlink', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Une démo du radar pour Automata', exact: true }).click();
    await page.getByRole('dialog', { name: 'Capture detail' }).waitFor();
    await page.getByRole('checkbox', { name: 'Projet créé au navigateur', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close detail' }).click();
    await page.getByRole('heading', { name: 'Project', exact: true }).waitFor();
    await page.screenshot({ path: '.shots/projects-desktop.jpg', fullPage: true, type: 'jpeg', quality: 75 });
    // Creating from an existing project's editor must open a clean form and never
    // update the project that was being viewed.
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    if (await page.getByLabel('Name', { exact: true }).inputValue()) throw new Error('New project kept the old name');
    await page.getByLabel('Name', { exact: true }).fill('Second projet indépendant');
    await page.getByRole('button', { name: 'Save project' }).click();
    await page.getByRole('button', { name: 'Second projet indépendant', exact: false }).waitFor();
    await page.getByRole('button', { name: 'Projet créé au navigateur', exact: false }).waitFor();
    const backup = await (await page.request.get(`${base}/api/export`)).json();
    if (backup.projects.length !== 5 || backup.projectLinks.length !== 2)
      throw new Error('Project backup does not match UI');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/?view=today`);
    await page.locator('.calendar-panel').getByText('Formation · API et conversations', { exact: true }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error('Mobile dashboard overflows');
    await page.screenshot({ path: '.shots/today-mobile.jpg', fullPage: true, type: 'jpeg', quality: 70 });
    await page.goto(`${base}/capture`);
    await page.getByRole('button', { name: 'Today', exact: true }).waitFor();
    if (errors.length) throw new Error(errors.join('\n'));
    if (sourceReads !== 2) throw new Error(`Source cache expected two reads, got ${sourceReads}`);
    console.log(
      JSON.stringify(
        {
          dashboard: true,
          myDayCollapsedByDefault: true,
          myDayExpandedRemembered: true,
          radarRows: radar.rows,
          radarHeights: radar.heights,
          radarBarSegments: radar.barSegments,
          everything: true,
          projectCreateAndLink: true,
          projectDrawerReturn: true,
          newProjectClearsExistingSelection: true,
          backupIncludesProjects: true,
          mobileNoOverflow: true,
          capturePreserved: true,
          sourceReads,
          consoleErrors: errors,
          screenshots: ['.shots/today-desktop-collapsed.png', '.shots/today-desktop-expanded.png', '.shots/projects-desktop.jpg', '.shots/today-mobile.jpg'],
          calendar: 'fixture; live OAuth setup still required',
        },
        null,
        2,
      ),
    );
  } finally {
    await browser?.close();
    await app?.close();
    await new Promise((resolve) => sources.close(resolve));
    await close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
