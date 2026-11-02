// Starts the API (tsx watch) and the Vite dev server together.
// Env: `.env` at the repo root, plus the file named by DEV_SECRETS_FILE inside it
// (Groq key kept outside the repository).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
if (process.env.DEV_SECRETS_FILE && existsSync(process.env.DEV_SECRETS_FILE)) {
  process.loadEnvFile(process.env.DEV_SECRETS_FILE);
}

// Node is spawned directly (no shell) so stopping this script really stops both servers;
// on Windows a shell in between leaves orphans holding the ports.
const children = [
  // The API always listens on 3000 in dev (Vite proxies /api there), whatever PORT the shell sets.
  // stdin is ignored: a closed stdin (IDE previews, CI) makes the Vite CLI shut itself down.
  spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'src/server/index.ts'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PORT: '3000' },
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--strictPort'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  }),
];

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) {
  c.on('exit', (code) => {
    console.error(`[dev] ${c.spawnargs[1]} exited with code ${code}, stopping`);
    stop();
  });
}
