// A recording refused by the transcription service (server answers 422
// transcription_rejected) must stop retrying, stay on the device, be copyable out of the
// app, and remain reachable from the home banner.
//   node scripts/check-voice-rejected.mjs <base>
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD) and a fake microphone.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const outboxItems = () =>
  new Promise((res) => {
    const req = indexedDB.open('brain-capture');
    req.onsuccess = () => {
      const g = req.result.transaction('outbox').objectStore('outbox').getAll();
      g.onsuccess = () => res(g.result.map((i) => ({ kind: i.kind, bytes: i.audio?.size ?? 0, blocked: Boolean(i.blocked) })));
    };
  });

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  const wav = path.resolve('.data/voice-samples/fr.wav');
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(existsSync(wav) ? [`--use-file-for-fake-audio-capture=${wav}`] : [])],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  await context.grantPermissions(['microphone'], { origin: base });
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate(
    async ([email, password]) =>
      fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }),
    [process.env.OWNER_EMAIL, process.env.DEV_PASSWORD],
  );
  await page.reload();

  let uploads = 0;
  await page.route('**/api/captures/voice', (route) => {
    uploads += 1;
    return route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'transcription_rejected', message: 'The transcription service refused this recording (Request Entity Too Large).' }),
    });
  });

  await page.getByRole('button', { name: 'Record a voice note' }).click();
  await page.getByText('Recording', { exact: true }).waitFor();
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Stop and save' }).click();
  await page.getByText('Not saved yet').waitFor();
  const screen = {
    reasonShown: (await page.locator('.status-view .lead').innerText()).includes('Request Entity Too Large'),
    saveCopyShown: await page.getByRole('button', { name: 'Save a copy' }).isVisible(),
    tryAgainShown: await page.getByRole('button', { name: 'Try again' }).isVisible(),
    keepForLaterShown: await page.getByRole('button', { name: 'Keep it for later' }).isVisible(),
  };

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save a copy' }).click()]);
  const saved = path.resolve('.data', await download.suggestedFilename());
  await download.saveAs(saved);
  const items = await page.evaluate(outboxItems);
  const copy = { name: download.suggestedFilename(), bytes: statSync(saved).size, matchesStoredAudio: statSync(saved).size === items[0]?.bytes };

  // No automatic retries: the 3 s / 6 s / 12 s backoff would have sent several by now.
  await page.waitForTimeout(25_000);
  const retries = { uploadsAfter25s: uploads };

  // Leaving is possible and safe; the banner leads back to it; recording again keeps it.
  await page.getByRole('button', { name: 'Keep it for later' }).click();
  await page.waitForTimeout(800);
  const bannerShown = await page.getByText('A recording was refused by transcription').isVisible();
  if (!bannerShown) {
    await page.screenshot({ path: '.shots/voice-rejected-home.jpg', type: 'jpeg', quality: 60 });
    console.log('home text:', (await page.locator('body').innerText()).slice(0, 500).replace(/\n+/g, ' | '));
  }
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Record again' }).click();
  await page.getByText('Recording', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
  const kept = { bannerShown, itemsAfterRecordAgain: await page.evaluate(outboxItems) };

  const result = { screen, copy, retries, kept };
  console.log(JSON.stringify(result));
  await browser.close();
  const ok =
    screen.reasonShown &&
    screen.saveCopyShown &&
    screen.tryAgainShown &&
    screen.keepForLaterShown &&
    copy.bytes > 0 &&
    copy.matchesStoredAudio &&
    retries.uploadsAfter25s === 1 &&
    kept.bannerShown &&
    kept.itemsAfterRecordAgain.length === 1 &&
    kept.itemsAfterRecordAgain[0].blocked;
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
