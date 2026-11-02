// Android share target, end to end in the app:
//  A. a share opened at /share is saved exactly once (also under React StrictMode, where
//     effects run twice: run this against the Vite dev server to cover that case)
//  B. if the device refuses to store it, the shared content is not lost: the compose sheet
//     opens prefilled, and saving from there works once storage is back
//   node scripts/check-share.mjs http://localhost:5173
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD).
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:5173';
  const stamp = Date.now();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (sessionStorage.getItem('failStore') === '1') throw new DOMException('Simulated full storage', 'QuotaExceededError');
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
  const count = (q) => page.evaluate(async (s) => (await (await fetch(`/api/captures?status=all&q=${encodeURIComponent(s)}`)).json()).captures.length, q);

  // A
  const urlA = `https://www.linkedin.com/jobs/view/${stamp}`;
  await page.goto(`${base}/share?${new URLSearchParams({ text: `Check out this job at Alan ${urlA}` })}`);
  await page.locator('.saved-head').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  const shareOnce = { created: await count(String(stamp)), path: new URL(page.url()).pathname };

  // B
  const urlB = `https://jobs.qonto.com/automation-lead-${stamp}`;
  await page.evaluate(() => sessionStorage.setItem('failStore', '1'));
  await page.goto(`${base}/share?${new URLSearchParams({ title: `Automation Lead ${stamp}`, url: urlB })}`);
  const sheetOpened = await page.getByRole('dialog', { name: 'Save a link' }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
  const prefilled = sheetOpened ? (await page.getByRole('textbox', { name: 'Link' }).inputValue()) === urlB : false;
  const errorShown = await page.getByText('could not store it').isVisible();
  await page.evaluate(() => sessionStorage.removeItem('failStore'));
  let savedAfter = false;
  if (sheetOpened) {
    await page.getByRole('button', { name: 'Save' }).click();
    savedAfter = await page.locator('.saved-head').waitFor({ timeout: 15_000 }).then(() => true, () => false);
  }
  const storeFailure = { sheetOpened, prefilled, errorShown, savedAfter, created: await count(`automation-lead-${stamp}`) };

  const result = { shareOnce, storeFailure };
  console.log(JSON.stringify(result));
  await browser.close();
  const ok =
    shareOnce.created === 1 &&
    shareOnce.path === '/' &&
    storeFailure.sheetOpened &&
    storeFailure.prefilled &&
    storeFailure.errorShown &&
    storeFailure.savedAfter &&
    storeFailure.created === 1;
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
