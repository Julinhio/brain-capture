import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGroqAi, createUnavailableAi } from './ai/groq.js';
import { buildApp } from './app.js';
import { ensureOwner } from './auth/owner.js';
import { startClassificationSweeper } from './captures/sweeper.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, close } = await openDb(config.databaseUrl);
  if (config.ownerEmail && config.ownerPasswordHash) await ensureOwner(db, config.ownerEmail, config.ownerPasswordHash);

  const ai = config.groqApiKey
    ? createGroqAi({ apiKey: config.groqApiKey, transcribeModel: config.transcribeModel, classifyModel: config.classifyModel })
    : createUnavailableAi();

  const app = await buildApp({ db, ai, config, webDir: path.resolve(process.cwd(), 'dist/web'), logger: true });
  if (!config.groqApiKey) app.log.warn('GROQ_API_KEY is not set: voice capture and sorting are disabled');
  const stopSweeper = startClassificationSweeper(db, ai, app.log);

  const shutdown = async () => {
    stopSweeper();
    await app.close();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
