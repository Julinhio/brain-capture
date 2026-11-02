// Cancel pressed while the microphone permission is still pending must not start a
// recording once access is granted, and must release the microphone.
//   node scripts/check-cancel-while-starting.mjs http://localhost:3100
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD).
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.grantPermissions(['microphone'], { origin: base });
  // Simulate a permission prompt that takes 1.5 s to be answered, and track live mic tracks.
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__liveTracks = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      await new Promise((r) => setTimeout(r, 1500));
      const stream = await original(constraints);
      window.__liveTracks.push(...stream.getTracks());
      return stream;
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
  await page.getByRole('button', { name: 'Record a voice note' }).click();
  await page.getByText('Starting…').waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(3000);
  const result = {
    recordingStarted: await page.getByText('Recording', { exact: true }).isVisible(),
    backHome: await page.getByText(/on your mind\?/).isVisible(),
    micStillLive: await page.evaluate(() => window.__liveTracks.some((t) => t.readyState === 'live')),
  };
  console.log(JSON.stringify(result));
  await browser.close();
  process.exitCode = !result.recordingStarted && result.backHome && !result.micStillLive ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
