// Proves a backup file restores completely, into an ISOLATED local instance only:
//   node scripts/check-restore.mjs <local base url> <backup file>
// Refuses any host other than localhost. Signs in with the local test account from .env
// (OWNER_EMAIL / DEV_PASSWORD), checks the database starts empty, imports the file, exports
// again and compares every capture field by field, then imports a second time to prove
// nothing is duplicated or overwritten.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const [base, file] = process.argv.slice(2);
  if (!base || !file) throw new Error('Usage: check-restore.mjs <local base url> <backup file>');
  const host = new URL(base).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`Refusing to restore into ${host}: isolated local instances only`);

  const backup = JSON.parse(readFileSync(file, 'utf8'));
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.OWNER_EMAIL, password: process.env.DEV_PASSWORD }),
  });
  if (!login.ok) throw new Error(`Local sign-in failed (${login.status})`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const exportNow = async () => (await (await fetch(`${base}/api/export`, { headers: { cookie } })).json()).captures;
  const importFile = async () =>
    (await fetch(`${base}/api/import`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(backup) })).json();

  const before = (await exportNow()).length;
  // An instance that already holds captures is not isolated: stop before writing anything.
  if (before !== 0) {
    throw new Error(`The target already holds ${before} captures: use a fresh, empty instance for this check. Nothing was imported.`);
  }
  const first = await importFile();
  const restored = await exportNow();
  const sort = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id));
  const identical = JSON.stringify(sort(restored)) === JSON.stringify(sort(backup.captures));
  const second = await importFile();
  const afterSecond = (await exportNow()).length;

  const result = {
    backupCaptures: backup.captures.length,
    emptyBefore: before === 0,
    firstImport: first,
    restoredCaptures: restored.length,
    identicalFieldByField: identical,
    secondImport: second,
    countAfterSecondImport: afterSecond,
  };
  console.log(JSON.stringify(result, null, 2));
  const ok =
    result.emptyBefore &&
    first.inserted === backup.captures.length &&
    identical &&
    second.inserted === 0 &&
    afterSecond === backup.captures.length;
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
