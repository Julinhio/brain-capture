// Reproduces the Android case seen on 2026-11-02: airplane mode off, app in the foreground,
// the browser reports "online" before requests actually go through. The waiting capture
// must still be sent without tapping "Retry now".
//   node scripts/check-auto-retry.mjs http://localhost:3100
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD).
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const NETWORK_NOT_READY_MS = 4000;
const WAIT_FOR_AUTO_SEND_MS = 20_000;

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  const note = `Auto retry check ${Date.now()}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate(
    async ([email, password]) =>
      fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }),
    [process.env.OWNER_EMAIL, process.env.DEV_PASSWORD],
  );
  await page.reload();

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Text' }).click();
  await page.getByRole('textbox').fill(note);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Not saved yet').waitFor();
  await page.getByRole('button', { name: 'Keep it for later' }).click();
  await page.getByText('waiting to be saved').waitFor();

  // Network "back" but not usable yet: uploads fail fast for a few seconds.
  let blockUploads = true;
  await page.route('**/api/captures', (route) =>
    blockUploads && route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue(),
  );
  const backAt = Date.now();
  await context.setOffline(false);
  setTimeout(() => (blockUploads = false), NETWORK_NOT_READY_MS);

  const sent = await page
    .getByText('waiting to be saved')
    .waitFor({ state: 'detached', timeout: WAIT_FOR_AUTO_SEND_MS })
    .then(() => true, () => false);
  const secondsAfterReconnect = sent ? Math.round((Date.now() - backAt) / 100) / 10 : null;
  const capturesCreated = await page.evaluate(
    async (q) => (await (await fetch(`/api/captures?q=${encodeURIComponent(q)}`)).json()).captures.length,
    note,
  );
  console.log(JSON.stringify({ sentWithoutTap: sent, secondsAfterReconnect, capturesCreated }));
  await browser.close();
  process.exitCode = sent && capturesCreated === 1 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
