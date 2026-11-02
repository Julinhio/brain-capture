// Saves every capture of the owner as a JSON file, through the app's own export (read-only).
//   node --env-file=<secrets .env> scripts/backup.mjs [--url <app url>] [--dir <backup folder>] [--keep 30]
// Needs OWNER_EMAIL and OWNER_PASSWORD in the env file; the folder comes from --dir or
// BACKUP_DIR. Files are named brain-capture-<UTC timestamp>.json; only the newest --keep
// are kept. Nothing in the database is modified.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'https://brain-capture-production-8fa2.up.railway.app';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const base = arg('url', DEFAULT_URL).replace(/\/$/, '');
  const dir = arg('dir', process.env.BACKUP_DIR);
  const keep = Number(arg('keep', '30'));
  const { OWNER_EMAIL: email, OWNER_PASSWORD: password } = process.env;
  if (!dir) throw new Error('Backup folder missing: pass --dir or set BACKUP_DIR');
  if (!email || !password) throw new Error('OWNER_EMAIL and OWNER_PASSWORD are required (use --env-file)');
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a positive integer');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`Sign-in failed (${login.status})`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  try {
    const res = await fetch(`${base}/api/export`, { headers: { cookie } });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const raw = await res.text();
    const file = JSON.parse(raw);
    if (file.format !== 'brain-capture-export' || !Array.isArray(file.captures)) throw new Error('Unexpected export format');

    mkdirSync(dir, { recursive: true });
    const name = `brain-capture-${file.exportedAt.replace(/[:.]/g, '-')}.json`;
    const target = path.join(dir, name);
    // Write then rename: a crash mid-write never leaves a truncated file under a valid name.
    writeFileSync(`${target}.partial`, raw);
    renameSync(`${target}.partial`, target);

    const backups = readdirSync(dir)
      .filter((f) => /^brain-capture-.*\.json$/.test(f))
      .sort();
    const removed = backups.slice(0, Math.max(0, backups.length - keep));
    for (const f of removed) rmSync(path.join(dir, f));

    console.log(
      JSON.stringify({
        file: target,
        captures: file.captures.length,
        bytes: Buffer.byteLength(raw),
        sha256: createHash('sha256').update(raw).digest('hex'),
        appVersion: file.appVersion,
        prunedOldBackups: removed.length,
      }),
    );
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
