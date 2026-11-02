import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sweepClassifications } from '../src/server/captures/sweeper.js';
import { captures } from '../src/server/db/schema.js';
import type { Capture } from '../src/shared/types.js';
import { createUser, login, newClientId, setup, type TestContext } from './helpers.js';

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await setup();
  await createUser(ctx.db, 'julien@example.com');
  cookie = await login(ctx.app, 'julien@example.com');
});
afterEach(() => ctx.close());

async function post(payload: Record<string, unknown>, as = cookie) {
  return ctx.app.inject({ method: 'POST', url: '/api/captures', headers: { cookie: as }, payload });
}

async function list(as = cookie, status = 'open'): Promise<Capture[]> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/captures?status=${status}`, headers: { cookie: as } });
  return res.json().captures;
}

describe('text and link captures', () => {
  it('saves a text capture with its original text and an AI category', async () => {
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Padel court Saturday' };
    const res = await post({ clientId: newClientId(), kind: 'text', text: 'Book a padel court for Saturday', device: 'android' });
    expect(res.statusCode).toBe(201);
    const { capture } = res.json() as { capture: Capture };
    expect(capture).toMatchObject({
      kind: 'text',
      text: 'Book a padel court for Saturday',
      originalText: 'Book a padel court for Saturday',
      category: 'lifestyle',
      categorySource: 'auto',
      classificationStatus: 'done',
      title: 'Padel court Saturday',
      status: 'open',
      device: 'android',
    });
  });

  it('keeps the link even when the shared text wraps it', async () => {
    const res = await post({
      clientId: newClientId(),
      kind: 'link',
      text: 'Automation Lead chez Qonto https://www.welcometothejungle.com/fr/jobs/automation-lead).',
    });
    expect(res.statusCode).toBe(201);
    const { capture } = res.json() as { capture: Capture };
    expect(capture.url).toBe('https://www.welcometothejungle.com/fr/jobs/automation-lead');
    expect(capture.text).toBe('Automation Lead chez Qonto');
  });

  it('refuses non-web links', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a link']) {
      const res = await post({ clientId: newClientId(), kind: 'link', url });
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses an empty text capture', async () => {
    const res = await post({ clientId: newClientId(), kind: 'text', text: '   ' });
    expect(res.statusCode).toBe(400);
  });
});

describe('retries do not duplicate', () => {
  it('the same clientId sent twice is stored once', async () => {
    const clientId = newClientId();
    const first = await post({ clientId, kind: 'text', text: 'Idea: weekly digest' });
    const second = await post({ clientId, kind: 'text', text: 'Idea: weekly digest' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().capture.id).toBe(first.json().capture.id);
    expect(await list()).toHaveLength(1);
    // The retry did not ask the model a second time for an already sorted capture.
    expect(ctx.ai.classifyCalls).toHaveLength(1);
  });
});

describe('classification failure never loses a capture', () => {
  it('saves under Other when the model is down, then the sweeper sorts it', async () => {
    ctx.ai.failClassify = true;
    const res = await post({ clientId: newClientId(), kind: 'text', text: 'Follow up with the Doctolib recruiter' });
    expect(res.statusCode).toBe(201);
    const saved = res.json().capture as Capture;
    expect(saved).toMatchObject({ category: 'other', categorySource: 'fallback', classificationStatus: 'failed' });
    expect(saved.title).toBe('Follow up with the Doctolib recruiter');
    expect(await list()).toHaveLength(1);

    ctx.ai.failClassify = false;
    ctx.ai.nextClassification = { category: 'jobs', title: 'Doctolib recruiter follow-up' };
    const sorted = await sweepClassifications(ctx.db, ctx.ai, new Date(Date.now() + 60_000));
    expect(sorted).toBe(1);
    const [after] = await list();
    expect(after).toMatchObject({ category: 'jobs', categorySource: 'auto', title: 'Doctolib recruiter follow-up' });
  });

  it('stops retrying after three attempts', async () => {
    ctx.ai.failClassify = true;
    await post({ clientId: newClientId(), kind: 'text', text: 'Something' });
    const later = new Date(Date.now() + 60_000);
    await sweepClassifications(ctx.db, ctx.ai, later);
    await sweepClassifications(ctx.db, ctx.ai, later);
    await sweepClassifications(ctx.db, ctx.ai, later);
    expect(ctx.ai.classifyCalls).toHaveLength(3);
  });

  it('a late classification does not overwrite a manual category or title', async () => {
    ctx.ai.failClassify = true;
    const { capture } = (await post({ clientId: newClientId(), kind: 'text', text: 'Marc intro to accounting firm' })).json();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/captures/${capture.id}`,
      headers: { cookie },
      payload: { category: 'automata', title: 'Marc intro' },
    });
    ctx.ai.failClassify = false;
    ctx.ai.nextClassification = { category: 'lifestyle', title: 'Wrong guess' };
    await sweepClassifications(ctx.db, ctx.ai, new Date(Date.now() + 60_000));
    const [after] = await list();
    expect(after).toMatchObject({ category: 'automata', categorySource: 'manual', title: 'Marc intro', classificationStatus: 'done' });
  });
});

describe('editing and status', () => {
  it('editing the text keeps the original', async () => {
    const { capture } = (await post({ clientId: newClientId(), kind: 'text', text: 'Pich a WhatsApp asistant' })).json();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/captures/${capture.id}`,
      headers: { cookie },
      payload: { text: 'Pitch a WhatsApp assistant' },
    });
    expect(res.json().capture).toMatchObject({ text: 'Pitch a WhatsApp assistant', originalText: 'Pich a WhatsApp asistant' });
  });

  it('done and archived leave the open list and can be reopened', async () => {
    const a = (await post({ clientId: newClientId(), kind: 'text', text: 'Task A' })).json().capture;
    const b = (await post({ clientId: newClientId(), kind: 'text', text: 'Idea B' })).json().capture;
    const patch = (id: string, status: string) =>
      ctx.app.inject({ method: 'PATCH', url: `/api/captures/${id}`, headers: { cookie }, payload: { status } });

    expect((await patch(a.id, 'done')).json().capture.doneAt).not.toBeNull();
    await patch(b.id, 'archived');
    expect(await list()).toHaveLength(0);
    expect(await list(cookie, 'done')).toHaveLength(1);
    expect(await list(cookie, 'archived')).toHaveLength(1);

    const reopened = (await patch(a.id, 'open')).json().capture;
    expect(reopened).toMatchObject({ status: 'open', doneAt: null });
  });

  it('rejects unknown categories', async () => {
    const { capture } = (await post({ clientId: newClientId(), kind: 'text', text: 'x' })).json();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/captures/${capture.id}`,
      headers: { cookie },
      payload: { category: 'finance' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('isolation between accounts', () => {
  it('another account can neither see, read nor change my captures', async () => {
    const mine = (await post({ clientId: newClientId(), kind: 'text', text: 'Private note' })).json().capture as Capture;

    await createUser(ctx.db, 'intruder@example.com');
    const other = await login(ctx.app, 'intruder@example.com');

    expect(await list(other, 'all')).toHaveLength(0);
    const read = await ctx.app.inject({ method: 'GET', url: `/api/captures/${mine.id}`, headers: { cookie: other } });
    expect(read.statusCode).toBe(404);
    const write = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/captures/${mine.id}`,
      headers: { cookie: other },
      payload: { status: 'archived', text: 'hacked' },
    });
    expect(write.statusCode).toBe(404);

    const [row] = await ctx.db.select().from(captures).where(eq(captures.id, mine.id));
    expect(row).toMatchObject({ text: 'Private note', status: 'open' });
  });

  it('reusing someone else clientId creates my own capture instead of returning theirs', async () => {
    const clientId = newClientId();
    const mine = (await post({ clientId, kind: 'text', text: 'Mine' })).json().capture as Capture;
    await createUser(ctx.db, 'intruder@example.com');
    const other = await login(ctx.app, 'intruder@example.com');
    const theirs = await post({ clientId, kind: 'text', text: 'Theirs' }, other);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().capture.id).not.toBe(mine.id);
    expect(theirs.json().capture.text).toBe('Theirs');
  });
});
