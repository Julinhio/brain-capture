// Desktop quick capture bar and search, at desktop size:
//  1. device storage refuses the write -> the text stays in the field, nothing saved
//  2. double Enter -> one capture
//  3. offline, then the network comes back (failing for 4 s) -> the line moves from
//     "Not saved yet" to "Saved to …" by itself, one capture
//  4. search finds a capture marked done, labelled as such
//   node scripts/check-desktop-bar.mjs http://localhost:3100
// Uses the local test account from .env (OWNER_EMAIL / DEV_PASSWORD).
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.argv[2] ?? 'http://localhost:3100';
  const stamp = Date.now();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
  const bar = page.getByLabel('Quick capture');
  await bar.waitFor();
  const count = (q) => page.evaluate(async (s) => (await (await fetch(`/api/captures?status=all&q=${encodeURIComponent(s)}`)).json()).captures.length, q);
  const status = page.locator('.capture-bar-status');

  // 1
  const n1 = `Bar store failure ${stamp}`;
  await page.evaluate(() => (window.__failStore = true));
  await bar.fill(n1);
  await bar.press('Enter');
  await status.getByText('could not store it').waitFor();
  const storeFailure = { textKept: (await bar.inputValue()) === n1, created: await count(n1) };
  await page.evaluate(() => (window.__failStore = false));
  await bar.fill('');

  // 2
  const n2 = `Bar double enter ${stamp}`;
  await bar.fill(n2);
  await page.evaluate(() => {
    const form = document.querySelector('.capture-bar');
    form.requestSubmit();
    form.requestSubmit();
  });
  await status.getByText('Saved to').waitFor({ timeout: 15_000 });
  const doubleEnter = { created: await count(n2) };

  // 3
  const n3 = `Bar background save ${stamp}`;
  await context.setOffline(true);
  await bar.fill(n3);
  await bar.press('Enter');
  await status.getByText('Not saved yet').waitFor();
  let block = true;
  await page.route('**/api/captures', (route) =>
    block && route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue(),
  );
  await context.setOffline(false);
  setTimeout(() => (block = false), 4000);
  const lineUpdated = await status.getByText('Saved to').waitFor({ timeout: 25_000 }).then(() => true, () => false);
  const background = { lineUpdated, created: await count(n3) };

  // 4
  await page.evaluate(async (q) => {
    const r = await (await fetch(`/api/captures?status=all&q=${encodeURIComponent(q)}`)).json();
    await fetch(`/api/captures/${r.captures[0].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) });
  }, n2);
  await page.getByRole('searchbox').fill(n2);
  await page.getByRole('searchbox').press('Enter');
  const doneCard = page.locator('.card').filter({ hasText: n2 });
  const search = { found: await doneCard.waitFor({ timeout: 10_000 }).then(() => true, () => false), labelledDone: /\bdone\b/i.test(await doneCard.locator('.card-meta').innerText().catch(() => '')) };

  const result = { storeFailure, doubleEnter, background, search };
  console.log(JSON.stringify(result));
  await browser.close();
  const ok =
    storeFailure.textKept && storeFailure.created === 0 && doubleEnter.created === 1 && background.lineUpdated && background.created === 1 && search.found && search.labelledDone;
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
