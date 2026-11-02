// Browser proof for the PWA shell against a running production build:
//   node scripts/check-pwa.mjs http://localhost:3100
// Checks that the service worker activates, that the app opens with the network cut,
// that a capture made offline waits in the outbox, and that it is sent once online again.
// Needs DEV_PASSWORD / OWNER_EMAIL in .env (local test account only).
import { existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  mkdirSync('.shots', { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  const note = `Offline note ${Date.now()}`;
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(base);
  const login = await page.evaluate(
    async ([email, password]) =>
      (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).status,
    [process.env.OWNER_EMAIL, process.env.DEV_PASSWORD],
  );
  await page.reload();
  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.state;
  });
  // Let the service worker take control and finish precaching.
  await page.reload();
  await page.waitForTimeout(1000);
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));

  await context.setOffline(true);
  await page.reload();
  const offlineHome = await page.getByText(/on your mind\?/).isVisible();
  await page.screenshot({ path: '.shots/pwa-offline-home.jpg', type: 'jpeg', quality: 60 });

  await page.getByRole('button', { name: 'Text' }).click();
  await page.getByRole('textbox').fill(note);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Not saved yet').waitFor();
  await page.screenshot({ path: '.shots/pwa-offline-not-saved.jpg', type: 'jpeg', quality: 60 });
  await page.getByRole('button', { name: 'Keep it for later' }).click();
  const waiting = await page.getByText('1 capture is waiting to be saved.').isVisible();

  // Coming back online triggers the outbox on its own (no tap needed).
  await context.setOffline(false);
  await page.getByText('waiting to be saved').waitFor({ state: 'detached', timeout: 15_000 });
  await page.getByText(note).first().waitFor({ timeout: 10_000 });
  const stored = await page.evaluate(async (q) => {
    const r = await (await fetch(`/api/captures?q=${encodeURIComponent(q)}`)).json();
    return r.captures.length;
  }, note);

  console.log(JSON.stringify({ login, swState, controlled, offlineHome, waiting, storedOnServer: stored, pageErrors: errors }, null, 2));
  await browser.close();
  const ok = login === 200 && Boolean(swState) && controlled && offlineHome && waiting && stored === 1 && errors.length === 0;
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
