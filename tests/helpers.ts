import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ai, ClassifyInput, ClassifyResult } from '../src/server/ai/types.js';
import { AiRejectedError, AiUnavailableError } from '../src/server/ai/types.js';
import { buildApp } from '../src/server/app.js';
import { hashPassword } from '../src/server/auth/password.js';
import { loadConfig, type Config } from '../src/server/config.js';
import { openDb, type Db } from '../src/server/db/client.js';
import { users } from '../src/server/db/schema.js';

export class FakeAi implements Ai {
  available = true;
  classifyCalls: ClassifyInput[] = [];
  failClassify = false;
  failTranscribe = false;
  nextClassification: ClassifyResult = { category: 'jobs', title: 'Fake title' };
  transcript = 'Fake transcript';

  transcribeCalls = 0;

  /** Set to simulate the provider refusing the file itself (e.g. Groq 413). */
  rejectTranscribe: string | null = null;

  async transcribe() {
    this.transcribeCalls += 1;
    if (this.rejectTranscribe !== null) {
      throw new AiRejectedError('Groq refused', { status: 413, message: this.rejectTranscribe });
    }
    if (this.failTranscribe) throw new AiUnavailableError('transcription down');
    return { text: this.transcript };
  }

  async classify(input: ClassifyInput) {
    this.classifyCalls.push(input);
    if (this.failClassify) throw new AiUnavailableError('classification down');
    return this.nextClassification;
  }
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  ai: FakeAi;
  close: () => Promise<void>;
}

export const PASSWORD = 'correct horse battery staple';

export async function setup(configOverrides: Partial<Config> = {}): Promise<TestContext> {
  const { db, close } = await openDb('pglite:memory');
  const ai = new FakeAi();
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'pglite:memory' }), ...configOverrides };
  const app = await buildApp({ db, ai, config });
  return {
    app,
    db,
    ai,
    close: async () => {
      await app.close();
      await close();
    },
  };
}

export async function createUser(db: Db, email: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return row!.id;
}

/** Signs in and returns the Cookie header value to send on later requests. */
export async function login(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'bc_session');
  if (!cookie) throw new Error('no session cookie');
  return `bc_session=${cookie.value}`;
}

export function newClientId(): string {
  return randomUUID();
}

/** Serializes a multipart body the way a browser FormData upload would. */
export async function voicePayload(fields: Record<string, string>, audio: Uint8Array | null, type = 'audio/webm') {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (audio) form.append('audio', new Blob([audio], { type }), 'recording.webm');
  const request = new Request('http://local/upload', { method: 'POST', body: form });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { 'content-type': request.headers.get('content-type')! },
  };
}
