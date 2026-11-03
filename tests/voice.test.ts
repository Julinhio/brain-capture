import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captures } from '../src/server/db/schema.js';
import type { Capture } from '../src/shared/types.js';
import { createUser, login, newClientId, setup, voicePayload, type TestContext } from './helpers.js';

let ctx: TestContext;
let cookie: string;
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);

beforeEach(async () => {
  ctx = await setup();
  await createUser(ctx.db, 'julien@example.com');
  cookie = await login(ctx.app, 'julien@example.com');
});
afterEach(() => ctx.close());

async function upload(clientId: string, opts: { as?: string; audio?: Uint8Array | null; type?: string } = {}) {
  const { payload, headers } = await voicePayload(
    { clientId, durationMs: '41000', device: 'android' },
    opts.audio === undefined ? AUDIO : opts.audio,
    opts.type,
  );
  return ctx.app.inject({
    method: 'POST',
    url: '/api/captures/voice',
    headers: { ...headers, cookie: opts.as ?? cookie },
    payload,
  });
}

describe('voice capture', () => {
  it('transcribes, saves the text only and sorts it', async () => {
    ctx.ai.transcript = '  Met the owner of La Clé du Lac this morning.  ';
    ctx.ai.nextClassification = { category: 'automata', title: 'Conciergerie in Annecy pitch' };
    const res = await upload(newClientId());
    expect(res.statusCode).toBe(201);
    const capture = res.json().capture as Capture;
    expect(capture).toMatchObject({
      kind: 'voice',
      text: 'Met the owner of La Clé du Lac this morning.',
      originalText: 'Met the owner of La Clé du Lac this morning.',
      durationMs: 41000,
      device: 'android',
      category: 'automata',
      title: 'Conciergerie in Annecy pitch',
    });
  });

  it('a retried upload is neither transcribed twice nor duplicated', async () => {
    const clientId = newClientId();
    const first = await upload(clientId);
    const second = await upload(clientId);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().capture.id).toBe(first.json().capture.id);
    expect(ctx.ai.transcribeCalls).toBe(1);
    expect(await ctx.db.select().from(captures)).toHaveLength(1);
  });

  it('a transcription outage stores nothing and tells the phone to retry', async () => {
    const clientId = newClientId();
    ctx.ai.failTranscribe = true;
    const failed = await upload(clientId);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toBe('transcription_failed');
    expect(await ctx.db.select().from(captures)).toHaveLength(0);

    ctx.ai.failTranscribe = false;
    const retried = await upload(clientId);
    expect(retried.statusCode).toBe(201);
  });

  it('a recording refused by the provider gets a final 422 with the reason, and nothing is stored', async () => {
    ctx.ai.rejectTranscribe = 'Request Entity Too Large';
    const clientId = newClientId();
    const res = await upload(clientId);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'transcription_rejected',
      message: 'The transcription service refused this recording (Request Entity Too Large).',
    });
    expect(await ctx.db.select().from(captures)).toHaveLength(0);

    // A manual retry with the same clientId works once the provider accepts it.
    ctx.ai.rejectTranscribe = null;
    expect((await upload(clientId)).statusCode).toBe(201);
  });

  it('a silent recording is refused as such, not saved empty', async () => {
    ctx.ai.transcript = '   ';
    const res = await upload(newClientId());
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('empty_transcription');
    expect(await ctx.db.select().from(captures)).toHaveLength(0);
  });

  it('refuses a missing file and a non-audio file', async () => {
    expect((await upload(newClientId(), { audio: null })).statusCode).toBe(400);
    expect((await upload(newClientId(), { type: 'text/html' })).statusCode).toBe(400);
    expect(ctx.ai.transcribeCalls).toBe(0);
  });

  it('refuses anonymous uploads before transcribing anything', async () => {
    const res = await upload(newClientId(), { as: 'bc_session=nope' });
    expect(res.statusCode).toBe(401);
    expect(ctx.ai.transcribeCalls).toBe(0);
  });

  it('a clientId used by another account does not leak their capture', async () => {
    const clientId = newClientId();
    ctx.ai.transcript = 'Mine';
    const mine = (await upload(clientId)).json().capture as Capture;
    await createUser(ctx.db, 'intruder@example.com');
    const other = await login(ctx.app, 'intruder@example.com');
    ctx.ai.transcript = 'Theirs';
    const theirs = await upload(clientId, { as: other });
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().capture.id).not.toBe(mine.id);
    expect(theirs.json().capture.text).toBe('Theirs');
  });
});
