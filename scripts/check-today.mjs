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
            { key: 'interessante', label: 'Intéressantes', value: 18 },
            { key: 'postule', label: 'Candidatures', value: 12 },
            { key: 'ecartee', label: 'Écartées', value: 27 },
          ]
        : [
            { key: 'a_verifier', label: 'À vérifier', value: 56 },
            { key: 'contactee', label: 'Contactées', value: 8 },
            { key: 'audit_propose', label: 'Audit proposé', value: 2 },
            { key: 'audit_fait', label: 'Audit fait', value: 1 },
            { key: 'mission', label: 'Missions', value: 0 },
            { key: 'ecartee', label: 'Écartées', value: 4 },
          ];
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(
        JSON.stringify({
          version: 1,
          checkedAt: new Date().toISOString(),
          total: segments.reduce((n, m) => n + m.value, 0),
          new24h: kind === 'jobs' ? 14 : 6,
          segments,
          extra: [],
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
    await page
      .getByRole('heading', { name: 'Bonjour, Julien.' })
      .or(page.getByRole('heading', { name: 'Bonsoir, Julien.' }))
      .waitFor();
    await page.getByText('181', { exact: true }).waitFor();
    await page.getByText('La connexion Google doit être configurée', { exact: false }).waitFor();
    // Calendar display proof is fixture based; OAuth security / API pagination are tested separately.
    const day = window.date;
    await page.route('**/api/calendar/day?*', (route) =>
      route.fulfill({
        json: {
          state: 'ready',
          checkedAt: new Date().toISOString(),
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
    await page.getByText('Formation · API et conversations', { exact: true }).waitFor();
    await mkdir('.shots', { recursive: true });
    await page.screenshot({ path: '.shots/today-desktop.jpg', fullPage: true, type: 'jpeg', quality: 75 });
    await page.getByRole('button', { name: 'Everything', exact: false }).click();
    await page.getByRole('heading', { name: 'Automata', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Mes projets', exact: true }).click();
    await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
    await page.getByLabel('Nom', { exact: true }).fill('Projet créé au navigateur');
    await page.getByLabel('État', { exact: true }).selectOption('active');
    await page.getByLabel('Intention', { exact: true }).fill('Vérifier le parcours complet.');
    await page.getByRole('button', { name: 'Enregistrer le projet' }).click();
    const projectButton = page.getByRole('button', { name: 'Projet créé au navigateur', exact: false });
    await projectButton.waitFor();
    await projectButton.click();
    await page.getByLabel('Ajouter une capture').fill('radar');
    await page.getByRole('button', { name: 'Lier', exact: true }).click();
    await page.getByRole('button', { name: 'Détacher', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Une démo du radar pour Automata', exact: true }).click();
    await page.getByRole('dialog', { name: 'Capture detail' }).waitFor();
    await page.getByRole('checkbox', { name: 'Projet créé au navigateur', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close detail' }).click();
    await page.getByRole('heading', { name: 'Le projet', exact: true }).waitFor();
    await page.screenshot({ path: '.shots/projects-desktop.jpg', fullPage: true, type: 'jpeg', quality: 75 });
    const backup = await (await page.request.get(`${base}/api/export`)).json();
    if (backup.projects.length !== 4 || backup.projectLinks.length !== 2)
      throw new Error('Project backup does not match UI');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/?view=today`);
    await page.getByText('Formation · API et conversations', { exact: true }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error('Mobile dashboard overflows');
    await page.screenshot({ path: '.shots/today-mobile.jpg', fullPage: true, type: 'jpeg', quality: 70 });
    await page.goto(`${base}/capture`);
    await page.getByRole('button', { name: 'Aujourd’hui', exact: true }).waitFor();
    if (errors.length) throw new Error(errors.join('\n'));
    if (sourceReads !== 2) throw new Error(`Source cache expected two reads, got ${sourceReads}`);
    console.log(
      JSON.stringify(
        {
          dashboard: true,
          everything: true,
          projectCreateAndLink: true,
          projectDrawerReturn: true,
          backupIncludesProjects: true,
          mobileNoOverflow: true,
          capturePreserved: true,
          sourceReads,
          consoleErrors: errors,
          screenshots: ['.shots/today-desktop.jpg', '.shots/projects-desktop.jpg', '.shots/today-mobile.jpg'],
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
