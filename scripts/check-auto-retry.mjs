// Reproduces the Android cases seen on 2026-11-02: a capture made in airplane mode, then the
// network comes back while the app stays in the foreground and nobody taps anything. The
// browser reports "online" before requests go through, so uploads fail for a few seconds.
// The capture must reach the server once, and the screen must say so.
//
//   node scripts/check-auto-retry.mjs <base> [--path stay|keep] [--kind text|voice] [--wav file]
//
// --path stay  (default) stays on "Not saved yet", like Julien's real test.
// --path keep  taps "Keep it for later" and watches the home banner.
// --kind voice records through Chromium's fake microphone (needs GROQ_API_KEY on the server).
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const NETWORK_NOT_READY_MS = 4000;
const WAIT_FOR_AUTO_SEND_MS = 25_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  const mode = arg('path', 'stay');
  const kind = arg('kind', 'text');
  const wav = path.resolve(arg('wav', '.data/voice-samples/fr.wav'));
  const note = `Auto retry check ${Date.now()}`;

  const browser = await chromium.launch({
    args:
      kind === 'voice'
        ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`]
        : [],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (kind === 'voice') await context.grantPermissions(['microphone'], { origin: base });
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate(
    async ([email, password]) =>
      fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }),
    [process.env.OWNER_EMAIL, process.env.DEV_PASSWORD],
  );
  await page.reload();
  const countAll = () => page.evaluate(async () => (await (await fetch('/api/captures?status=all&limit=200')).json()).captures.length);
  const before = await countAll();

  await context.setOffline(true);
  if (kind === 'voice') {
    await page.getByRole('button', { name: 'Record a voice note' }).click();
    await page.getByText('Recording', { exact: true }).waitFor();
    await page.waitForTimeout(6000);
    await page.getByRole('button', { name: 'Stop and save' }).click();
  } else {
    await page.getByRole('button', { name: 'Text' }).click();
    await page.getByRole('textbox').fill(note);
    await page.getByRole('button', { name: 'Save' }).click();
  }
  await page.getByText('Not saved yet').waitFor();
  if (mode === 'keep') {
    await page.getByRole('button', { name: 'Keep it for later' }).click();
    await page.getByText('waiting to be saved').waitFor();
  }

  // Network "back" but not usable yet: uploads fail fast for a few seconds.
  let blockUploads = true;
  await page.route(/\/api\/captures(\/voice)?$/, (route) =>
    blockUploads && route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue(),
  );
  const backAt = Date.now();
  await context.setOffline(false);
  setTimeout(() => (blockUploads = false), NETWORK_NOT_READY_MS);

  // What the person sees: the screen they stayed on must move on by itself.
  const uiDone =
    mode === 'keep'
      ? page.getByText('waiting to be saved').waitFor({ state: 'detached', timeout: WAIT_FOR_AUTO_SEND_MS })
      : page.locator('.saved-head').waitFor({ timeout: WAIT_FOR_AUTO_SEND_MS });
  const screenUpdated = await uiDone.then(() => true, () => false);
  const seconds = Math.round((Date.now() - backAt) / 100) / 10;
  const stillSaysNotSaved = await page.getByText('Not saved yet').isVisible();
  const created = (await countAll()) - before;

  console.log(JSON.stringify({ mode, kind, screenUpdated, secondsAfterReconnect: screenUpdated ? seconds : null, stillSaysNotSaved, capturesCreated: created }));
  await browser.close();
  process.exitCode = screenUpdated && !stillSaysNotSaved && created === 1 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
