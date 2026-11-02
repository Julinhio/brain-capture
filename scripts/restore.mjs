// Restores a backup file into the app through /api/import (the real restore, not a check).
//   node --env-file=<secrets .env> scripts/restore.mjs --file <backup.json> [--url <app url>] [--yes]
// Only adds captures that are missing; never overwrites or deletes. Any target other than
// localhost requires --yes, so a production restore is always a deliberate act.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'https://brain-capture-production-8fa2.up.railway.app';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const base = arg('url', DEFAULT_URL).replace(/\/$/, '');
  const file = arg('file');
  if (!file) throw new Error('Pass --file <backup.json>');
  const local = ['localhost', '127.0.0.1', '::1'].includes(new URL(base).hostname);
  if (!local && !process.argv.includes('--yes')) {
    throw new Error(`Restoring into ${base} needs --yes (adds missing captures only, never overwrites).`);
  }
  const { OWNER_EMAIL: email, OWNER_PASSWORD: password } = process.env;
  if (!email || !password) throw new Error('OWNER_EMAIL and OWNER_PASSWORD are required (use --env-file)');

  const backup = JSON.parse(readFileSync(file, 'utf8'));
  if (backup.format !== 'brain-capture-export') throw new Error('Not a Brain Capture backup file');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`Sign-in failed (${login.status})`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  try {
    const res = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(backup),
    });
    if (!res.ok) throw new Error(`Import failed (${res.status}): ${await res.text()}`);
    console.log(JSON.stringify({ target: base, file, ...(await res.json()) }));
  } finally {
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
