/**
 * Proves a category created in the app is sorted into by the real classifier, with no code
 * change: an isolated in-memory instance (never production), a category added through the
 * API, then a few captures sent through the API and sorted by Groq.
 * Usage: npx tsx --env-file=<path to .env with GROQ_API_KEY> scripts/eval-new-category.ts
 * Costs a fraction of a cent (a handful of short completions).
 */
import { pathToFileURL } from 'node:url';
import { createGroqAi } from '../src/server/ai/groq.js';
import { buildApp } from '../src/server/app.js';
import { hashPassword } from '../src/server/auth/password.js';
import { loadConfig } from '../src/server/config.js';
import { openDb } from '../src/server/db/client.js';
import { users } from '../src/server/db/schema.js';

const CATEGORY = {
  name: 'Santé',
  description: 'Health and body: doctors, physiotherapy, dentist, medication, sport sessions, sleep, nutrition.',
};
const CASES: { text: string; expected: string }[] = [
  { text: 'Prendre rendez-vous chez le kiné pour mon genou, deux séances par semaine.', expected: 'sante' },
  { text: 'Penser à racheter du magnésium et à me coucher avant 23 h cette semaine.', expected: 'sante' },
  // Controls: still sorted where they belong, the new category does not swallow everything.
  { text: 'Errands: pick up the parcel at the post office and buy coffee.', expected: 'lifestyle' },
  { text: 'Relancer la recruteuse de Doctolib pour le poste de product ops.', expected: 'jobs' },
];

async function main(): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is missing (pass --env-file)');
  const { db, close } = await openDb('pglite:memory');
  const ai = createGroqAi({
    apiKey,
    transcribeModel: 'whisper-large-v3-turbo',
    classifyModel: process.env.GROQ_CLASSIFY_MODEL || 'openai/gpt-oss-20b',
  });
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'pglite:memory' });
  const app = await buildApp({ db, ai, config });
  try {
    const password = crypto.randomUUID();
    await db.insert(users).values({ email: 'eval@local.test', passwordHash: await hashPassword(password) });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'eval@local.test', password } });
    const cookie = `bc_session=${login.cookies.find((c) => c.name === 'bc_session')!.value}`;

    const created = await app.inject({ method: 'POST', url: '/api/categories', headers: { cookie }, payload: CATEGORY });
    if (created.statusCode !== 201) throw new Error(`Category not created: ${created.body}`);
    console.log(`Created category ${JSON.stringify(created.json().category)}`);
    // What Julien would do next: the starting Lifestyle description also lists health and
    // sport, so two categories would claim the same notes. Descriptions decide, keep them apart.
    const lifestyle = await app.inject({
      method: 'PATCH',
      url: '/api/categories/lifestyle',
      headers: { cookie },
      payload: { description: 'Personal tasks & interests. Personal life: errands, family, friends, home, travel, admin paperwork, hobbies.' },
    });
    if (lifestyle.statusCode !== 200) throw new Error(`Lifestyle not updated: ${lifestyle.body}`);
    console.log('Lifestyle description: health and sport now belong to Santé');

    let ok = 0;
    for (const [i, c] of CASES.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, Number(process.env.EVAL_DELAY_MS ?? 4000)));
      const res = await app.inject({
        method: 'POST',
        url: '/api/captures',
        headers: { cookie },
        payload: { clientId: crypto.randomUUID(), kind: 'text', text: c.text },
      });
      const capture = res.json().capture as { category: string; title: string; classificationStatus: string };
      const good = capture.category === c.expected;
      if (good) ok += 1;
      console.log(
        `${good ? 'OK ' : 'XX '} ${capture.category.padEnd(8)} (exp ${c.expected.padEnd(6)}) ${capture.classificationStatus}  ${capture.title}  ← ${c.text}`,
      );
    }
    console.log(`\n${ok}/${CASES.length} as expected`);
    process.exitCode = ok === CASES.length ? 0 : 1;
  } finally {
    await app.close();
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
