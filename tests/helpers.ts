import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  Ai,
  ClassifyInput,
  ClassifyResult,
  EventExtractInput,
  EventExtraction,
  ExtractedFood,
  NutritionExtractInput,
  NutritionExtraction,
  PhotoInput,
} from '../src/server/ai/types.js';
import { AiRejectedError, AiUnavailableError } from '../src/server/ai/types.js';
import { buildApp } from '../src/server/app.js';
import { hashPassword } from '../src/server/auth/password.js';
import { loadConfig, type Config } from '../src/server/config.js';
import { openDb, type Db } from '../src/server/db/client.js';
import { users } from '../src/server/db/schema.js';
import { createFoodLookup, type FoodLookup } from '../src/server/nutrition/foods.js';

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

  /** Awaited inside transcribe: lets a test act while an upload is still being transcribed. */
  transcribeGate: Promise<void> | null = null;

  async transcribe() {
    this.transcribeCalls += 1;
    if (this.transcribeGate) await this.transcribeGate;
    if (this.rejectTranscribe !== null) {
      throw new AiRejectedError('Groq refused', { status: 413, message: this.rejectTranscribe });
    }
    if (this.failTranscribe) throw new AiUnavailableError('transcription down');
    return { text: this.transcript };
  }

  eventCalls: EventExtractInput[] = [];
  failEvent = false;
  nextEvent: EventExtraction = {
    isEventRequest: true,
    title: 'Dentiste',
    allDay: false,
    start: '2026-11-17T15:00',
    startTimeZone: null,
    end: null,
    endTimeZone: null,
    location: null,
  };

  async extractEvent(input: EventExtractInput) {
    this.eventCalls.push(input);
    if (this.failEvent) throw new AiUnavailableError('extraction down');
    return this.nextEvent;
  }

  async classify(input: ClassifyInput) {
    this.classifyCalls.push(input);
    if (this.failClassify) throw new AiUnavailableError('classification down');
    return this.nextClassification;
  }

  nutritionCalls: NutritionExtractInput[] = [];
  failNutrition = false;
  nextNutrition: NutritionExtraction = meal([food('banane', 'banane crue', 120, 89)]);

  async extractNutrition(input: NutritionExtractInput) {
    this.nutritionCalls.push(input);
    if (this.failNutrition) throw new AiUnavailableError('nutrition reading down');
    return this.nextNutrition;
  }

  photoCalls: PhotoInput[] = [];
  failPhoto = false;
  /** Set to simulate the provider refusing the picture itself. */
  rejectPhoto: string | null = null;
  nextPhoto: NutritionExtraction = { ...meal([food('apple', 'pomme crue', 150, 52)]), description: 'A red apple on a table.' };

  async readPhoto(input: PhotoInput) {
    this.photoCalls.push(input);
    if (this.rejectPhoto !== null) throw new AiRejectedError('Groq refused', { status: 400, message: this.rejectPhoto });
    if (this.failPhoto) throw new AiUnavailableError('vision down');
    return this.nextPhoto;
  }
}

const NOTHING: NutritionExtraction = {
  type: 'none',
  dayOffset: 0,
  title: '',
  slot: null,
  items: [],
  activity: null,
  minutes: null,
  met: null,
  kcal: null,
  kg: null,
  description: '',
  text: '',
};

/** One food as the model would answer it: its own estimate per 100 g, before any table lookup. */
export function food(name: string, nameFr: string, grams: number, kcal100: number, brand: string | null = null): ExtractedFood {
  return { name, nameFr, brand, grams, kcal100, protein100: 1, carbs100: 20, fat100: 0.3 };
}
export const meal = (items: ExtractedFood[], extra: Partial<NutritionExtraction> = {}): NutritionExtraction => ({ ...NOTHING, type: 'meal', items, ...extra });
export const workout = (activity: string, minutes: number | null, met: number | null, extra: Partial<NutritionExtraction> = {}): NutritionExtraction => ({
  ...NOTHING,
  type: 'workout',
  activity,
  minutes,
  met,
  ...extra,
});
export const weight = (kg: number, extra: Partial<NutritionExtraction> = {}): NutritionExtraction => ({ ...NOTHING, type: 'weight', kg, ...extra });
export const notNutrition = (extra: Partial<NutritionExtraction> = {}): NutritionExtraction => ({ ...NOTHING, ...extra });

/** Serializes a photo upload the way the app sends it: fields first, then the picture and its thumbnail. */
export async function photoPayload(fields: Record<string, string>, image: Uint8Array | null, thumb: Uint8Array | null = null) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (image) form.append('image', new Blob([image], { type: 'image/jpeg' }), 'photo.jpg');
  if (thumb) form.append('thumb', new Blob([thumb], { type: 'image/jpeg' }), 'thumb.jpg');
  const request = new Request('http://local/upload', { method: 'POST', body: form });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { 'content-type': request.headers.get('content-type')! },
  };
}

/** The smallest thing that starts like a JPEG: enough for the server's type check. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  ai: FakeAi;
  close: () => Promise<void>;
}

export const PASSWORD = 'correct horse battery staple';

export async function setup(configOverrides: Partial<Config> = {}, deps: { foods?: FoodLookup } = {}): Promise<TestContext> {
  const { db, close } = await openDb('pglite:memory');
  const ai = new FakeAi();
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'pglite:memory' }), ...configOverrides };
  // No product search by default: tests never reach Open Food Facts unless they pass a stub.
  const app = await buildApp({ db, ai, config, foods: deps.foods ?? createFoodLookup({ fetchImpl: null }) });
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
