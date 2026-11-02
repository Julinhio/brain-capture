// End-to-end voice proof with a real browser recorder: Chromium's fake microphone plays a
// WAV file, the app records it with MediaRecorder, uploads it, Groq transcribes and sorts.
//   node scripts/check-voice-browser.mjs http://localhost:3100 .data/voice-samples/fr.wav
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD).
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  const wav = path.resolve(process.argv[3] ?? '.data/voice-samples/fr.wav');
  mkdirSync('.shots', { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.grantPermissions(['microphone'], { origin: base });
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate(
    async ([email, password]) =>
      fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }),
    [process.env.OWNER_EMAIL, process.env.DEV_PASSWORD],
  );
  await page.reload();
  await page.getByRole('button', { name: 'Record a voice note' }).click();
  await page.getByText('Recording', { exact: true }).waitFor();
  await page.waitForTimeout(9000);
  await page.screenshot({ path: '.shots/voice-recording.jpg', type: 'jpeg', quality: 60 });
  await page.getByRole('button', { name: 'Stop and save' }).click();
  try {
    await page.locator('.saved-head').waitFor({ timeout: 30_000 });
  } catch (err) {
    await page.screenshot({ path: '.shots/voice-failed.jpg', type: 'jpeg', quality: 60 });
    console.log('page text at failure:', (await page.locator('body').innerText()).slice(0, 600));
    throw err;
  }
  await page.screenshot({ path: '.shots/voice-saved.jpg', type: 'jpeg', quality: 60 });
  const result = await page.evaluate(async () => {
    const r = await (await fetch('/api/captures?status=open&limit=1')).json();
    const c = r.captures[0];
    const req = indexedDB.open('brain-capture');
    const pending = await new Promise((res) => {
      req.onsuccess = () => {
        const count = req.result.transaction('outbox').objectStore('outbox').count();
        count.onsuccess = () => res(count.result);
      };
    });
    return { kind: c.kind, durationMs: c.durationMs, text: c.text, title: c.title, category: c.category, outboxLeft: pending };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
