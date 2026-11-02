// When the device refuses to store a recording (IndexedDB full or blocked), the recording
// must not be lost: it is sent straight from memory, and if the network is down too the
// screen says it only exists there and offers a retry.
//   node scripts/check-voice-store-failure.mjs <base> [wav]   (needs GROQ_API_KEY on the server)
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  const wav = path.resolve(process.argv[3] ?? '.data/voice-samples/fr.wav');
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.grantPermissions(['microphone'], { origin: base });
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.__failStore) throw new DOMException('Simulated full storage', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate(
    async ([email, password]) =>
      fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }),
    [process.env.OWNER_EMAIL, process.env.DEV_PASSWORD],
  );
  await page.reload();
  const countAll = () => page.evaluate(async () => (await (await fetch('/api/captures?status=all&limit=200')).json()).captures.length);
  const record = async () => {
    await page.getByRole('button', { name: 'Record a voice note' }).click();
    await page.getByText('Recording', { exact: true }).waitFor();
    await page.waitForTimeout(5000);
    await page.getByRole('button', { name: 'Stop and save' }).click();
  };
  await page.evaluate(() => (window.__failStore = true));

  // A: storage refused, network fine -> sent straight from memory.
  const beforeA = await countAll();
  await record();
  const savedA = await page.locator('.saved-head').waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const createdA = (await countAll()) - beforeA;
  await page.getByRole('button', { name: 'Done' }).click();

  // B: storage refused and offline -> honest screen, no "Keep it for later", retry works.
  const beforeB = await countAll();
  await context.setOffline(true);
  await record();
  await page.getByText('Not saved yet').waitFor();
  const warnsOnlyHere = await page.getByText('Only on this screen').isVisible();
  const offersKeepForLater = await page.getByRole('button', { name: 'Keep it for later' }).isVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Retry now' }).click();
  const savedB = await page.locator('.saved-head').waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const createdB = (await countAll()) - beforeB;

  const result = { savedA, createdA, warnsOnlyHere, offersKeepForLater, savedB, createdB };
  console.log(JSON.stringify(result));
  await browser.close();
  process.exitCode = savedA && createdA === 1 && warnsOnlyHere && !offersKeepForLater && savedB && createdB === 1 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
