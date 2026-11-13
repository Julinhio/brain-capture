import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { classifyCapture } from '../src/server/captures/service.js';
import { sweepClassifications } from '../src/server/captures/sweeper.js';
import { captureEvents, captures, deletedCaptures, projectCaptures, projects } from '../src/server/db/schema.js';
import { createUser, login, newClientId, setup, voicePayload, type TestContext } from './helpers.js';

describe('deleting a capture for good', () => {
  let ctx: TestContext;
  let owner: string;
  let cookie: string;
  beforeAll(async () => {
    ctx = await setup();
    owner = await createUser(ctx.db, 'delete@example.com');
    cookie = await login(ctx.app, 'delete@example.com');
  });
  afterAll(() => ctx.close());

  const create = async (text: string, clientId = newClientId()) => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/captures', headers: { cookie }, payload: { clientId, kind: 'text', text } });
    expect(res.statusCode).toBe(201);
    return res.json().capture as { id: string; clientId: string };
  };
  const remove = (id: string, as = cookie) => ctx.app.inject({ method: 'DELETE', url: `/api/captures/${id}`, headers: { cookie: as } });

  it('removes the capture, its project links and its calendar suggestion', async () => {
    const c = await create('Mets dans mon agenda kiné jeudi à 18 h');
    const [project] = await ctx.db.insert(projects).values({ ownerId: owner, name: 'Rééducation' }).returning();
    await ctx.db.insert(projectCaptures).values({ projectId: project!.id, captureId: c.id });
    expect(await ctx.db.select().from(captureEvents).where(eq(captureEvents.captureId, c.id))).toHaveLength(1);

    const res = await remove(c.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect((await ctx.app.inject({ url: `/api/captures/${c.id}`, headers: { cookie } })).statusCode).toBe(404);
    expect(await ctx.db.select().from(captures).where(eq(captures.id, c.id))).toHaveLength(0);
    expect(await ctx.db.select().from(projectCaptures).where(eq(projectCaptures.captureId, c.id))).toHaveLength(0);
    expect(await ctx.db.select().from(captureEvents).where(eq(captureEvents.captureId, c.id))).toHaveLength(0);
    // The project itself is untouched.
    expect(await ctx.db.select().from(projects).where(eq(projects.id, project!.id))).toHaveLength(1);
    const [left] = await ctx.db.select().from(deletedCaptures).where(eq(deletedCaptures.captureId, c.id));
    expect(left).toMatchObject({ ownerId: owner, clientId: c.clientId, reason: 'deleted', calendarEvent: null });
  });

  it('a repeated delete (lost answer) is harmless; an unknown id is not found', async () => {
    const c = await create('Test capture');
    expect((await remove(c.id)).statusCode).toBe(200);
    expect((await remove(c.id)).json()).toEqual({ deleted: true });
    expect((await remove('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('cannot delete another account’s capture', async () => {
    const c = await create('Mine');
    await createUser(ctx.db, 'other-deleter@example.com');
    const other = await login(ctx.app, 'other-deleter@example.com');
    expect((await remove(c.id, other)).statusCode).toBe(404);
    expect(await ctx.db.select().from(captures).where(eq(captures.id, c.id))).toHaveLength(1);
  });

  it('does not come back when the phone sends it again (text, then voice)', async () => {
    const text = await create('Saved, answer lost, then deleted on the desktop');
    await remove(text.id);
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/captures',
      headers: { cookie },
      payload: { clientId: text.clientId, kind: 'text', text: 'Saved, answer lost, then deleted on the desktop' },
    });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ error: 'capture_deleted' });

    const clientId = newClientId();
    const fields = { clientId, durationMs: '3000' };
    const first = await voicePayload(fields, new Uint8Array([1, 2, 3]));
    const saved = await ctx.app.inject({ method: 'POST', url: '/api/captures/voice', headers: { cookie, ...first.headers }, payload: first.payload });
    expect(saved.statusCode).toBe(201);
    await remove(saved.json().capture.id);
    const transcriptions = ctx.ai.transcribeCalls;
    const retry = await voicePayload(fields, new Uint8Array([1, 2, 3]));
    const resent = await ctx.app.inject({ method: 'POST', url: '/api/captures/voice', headers: { cookie, ...retry.headers }, payload: retry.payload });
    expect(resent.statusCode).toBe(410);
    // Refused before any transcription is paid for.
    expect(ctx.ai.transcribeCalls).toBe(transcriptions);
    expect(await ctx.db.select().from(captures).where(eq(captures.clientId, clientId))).toHaveLength(0);
  });

  it('an upload still being transcribed when the capture is deleted does not store it again', async () => {
    const clientId = newClientId();
    const fields = { clientId, durationMs: '3000' };
    const first = await voicePayload(fields, new Uint8Array([1, 2, 3]));
    const saved = await ctx.app.inject({ method: 'POST', url: '/api/captures/voice', headers: { cookie, ...first.headers }, payload: first.payload });
    expect(saved.statusCode).toBe(201);
    // The phone lost the answer and retried while the first upload was still running: the retry
    // found nothing stored yet and is now held in transcription. The row is taken out of its way
    // to recreate that moment, then the deletion lands while it transcribes.
    let release!: () => void;
    ctx.ai.transcribeGate = new Promise<void>((r) => (release = r));
    const db = ctx.db;
    const retryBody = await voicePayload(fields, new Uint8Array([1, 2, 3]));
    await db.delete(captures).where(eq(captures.clientId, clientId));
    const retry = ctx.app.inject({ method: 'POST', url: '/api/captures/voice', headers: { cookie, ...retryBody.headers }, payload: retryBody.payload });
    while (ctx.ai.transcribeCalls < 2) await new Promise((r) => setTimeout(r, 10));
    // The deletion lands (its tombstone) while the retry is still transcribing.
    await db.insert(deletedCaptures).values({ captureId: saved.json().capture.id, ownerId: owner, clientId, reason: 'deleted' });
    release();
    ctx.ai.transcribeGate = null;
    const res = await retry;
    expect(res.statusCode).toBe(410);
    expect(await db.select().from(captures).where(eq(captures.clientId, clientId))).toHaveLength(0);
  });

  it('a sorting retry or a late classification does not bring it back', async () => {
    ctx.ai.failClassify = true;
    const c = await create('Sorting failed, retried later');
    ctx.ai.failClassify = false;
    const [stale] = await ctx.db.select().from(captures).where(eq(captures.id, c.id));
    await remove(c.id);
    // The sweeper finds nothing to do, and a classification already in flight writes nothing.
    await sweepClassifications(ctx.db, ctx.ai, new Date(Date.now() + 3_600_000));
    await classifyCapture(ctx.db, ctx.ai, stale!);
    expect(await ctx.db.select().from(captures).where(eq(captures.id, c.id))).toHaveLength(0);
  });

  it('restoring an older backup does not bring it back', async () => {
    const c = await create('In the backup, deleted afterwards');
    const backup = (await ctx.app.inject({ url: '/api/export', headers: { cookie } })).json();
    await remove(c.id);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/import', headers: { cookie }, payload: backup });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.select().from(captures).where(eq(captures.id, c.id))).toHaveLength(0);
  });
});
