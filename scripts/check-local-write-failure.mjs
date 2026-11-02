// Simulates the device refusing to store a capture (IndexedDB quota exceeded), then checks
// that the compose sheet unlocks with the text intact, and that the next try saves once.
//   node scripts/check-local-write-failure.mjs http://localhost:3100
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD).
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  const note = `Local write failure check ${Date.now()}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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
  await page.getByRole('button', { name: 'Text' }).click();
  await page.getByRole('textbox').fill(note);

  await page.evaluate(() => (window.__failStore = true));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1500);
  const afterFailure = {
    errorShown: await page.getByRole('alert').filter({ hasText: 'could not store it' }).isVisible(),
    saveEnabled: await page.getByRole('button', { name: 'Save' }).isEnabled(),
    textKept: (await page.getByRole('textbox').inputValue()) === note,
  };

  await page.evaluate(() => (window.__failStore = false));
  let savedOnRetry = false;
  if (afterFailure.saveEnabled) {
    await page.getByRole('button', { name: 'Save' }).click();
    savedOnRetry = await page.locator('.saved-head').waitFor({ timeout: 10_000 }).then(() => true, () => false);
  }
  const capturesCreated = await page.evaluate(
    async (q) => (await (await fetch(`/api/captures?q=${encodeURIComponent(q)}`)).json()).captures.length,
    note,
  );
  const result = { ...afterFailure, savedOnRetry, capturesCreated };
  console.log(JSON.stringify(result));
  await browser.close();
  const ok = result.errorShown && result.saveEnabled && result.textKept && savedOnRetry && capturesCreated === 1;
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
