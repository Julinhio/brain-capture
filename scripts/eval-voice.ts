/**
 * Sends real audio files through the actual voice route (multipart upload, Groq Whisper,
 * then sorting) against an in-memory database. Nothing is stored anywhere afterwards.
 * Usage: npx tsx --env-file=<file with GROQ_API_KEY> scripts/eval-voice.ts a.wav b.webm
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGroqAi } from '../src/server/ai/groq.js';
import { buildApp } from '../src/server/app.js';
import { hashPassword } from '../src/server/auth/password.js';
import { loadConfig } from '../src/server/config.js';
import { openDb } from '../src/server/db/client.js';
import { users } from '../src/server/db/schema.js';

const MIME: Record<string, string> = { '.wav': 'audio/wav', '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Pass at least one audio file');
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'pglite:memory', GROQ_API_KEY: process.env.GROQ_API_KEY });
  if (!config.groqApiKey) throw new Error('GROQ_API_KEY is missing (pass --env-file)');
  const { db, close } = await openDb('pglite:memory');
  const ai = createGroqAi({ apiKey: config.groqApiKey, transcribeModel: config.transcribeModel, classifyModel: config.classifyModel });
  const app = await buildApp({ db, ai, config });

  const password = randomUUID();
  await db.insert(users).values({ email: 'eval@local.test', passwordHash: await hashPassword(password) });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'eval@local.test', password } });
  const cookie = `bc_session=${login.cookies.find((c) => c.name === 'bc_session')!.value}`;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const form = new FormData();
    form.append('clientId', randomUUID());
    form.append('durationMs', '10000');
    form.append('device', 'eval');
    form.append('audio', new Blob([readFileSync(file)], { type: MIME[ext] ?? 'audio/webm' }), `recording${ext}`);
    const request = new Request('http://local/upload', { method: 'POST', body: form });
    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/captures/voice',
      headers: { cookie, 'content-type': request.headers.get('content-type')! },
      payload: Buffer.from(await request.arrayBuffer()),
    });
    const body = res.json();
    console.log(`\n${path.basename(file)} -> ${res.statusCode} in ${Date.now() - started}ms`);
    if (res.statusCode >= 300) console.log(body);
    else console.log({ text: body.capture.text, title: body.capture.title, category: body.capture.category, sorted: body.capture.classificationStatus });
  }
  await app.close();
  await close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
