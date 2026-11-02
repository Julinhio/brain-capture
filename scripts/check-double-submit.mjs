// Fires two clicks on "Save" in the same tick (a fast double tap) and counts how many
// captures reach the server. Expected: 1.
//   node scripts/check-double-submit.mjs http://localhost:3100
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD).
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  const note = `Double tap check ${Date.now()}`;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await page.goto(base);
  await page.evaluate(
    async ([email, password]) =>
      fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }),
    [process.env.OWNER_EMAIL, process.env.DEV_PASSWORD],
  );
  await page.reload();
  await page.getByRole('button', { name: 'Text' }).click();
  await page.getByRole('textbox').fill(note);
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    save.click();
    save.click();
  });
  await page.waitForTimeout(3000);
  const count = await page.evaluate(
    async (q) => (await (await fetch(`/api/captures?q=${encodeURIComponent(q)}`)).json()).captures.length,
    note,
  );
  console.log(JSON.stringify({ capturesCreated: count }));
  await browser.close();
  process.exitCode = count === 1 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
