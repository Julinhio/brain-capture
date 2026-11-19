import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATEGORY_ID_RE } from '../../shared/categories.js';
import { extractUrl, normalizeUrl, removeLinkFromNote } from '../../shared/text.js';
import type { CaptureStatus } from '../../shared/types.js';
import { AiRejectedError, type AiUnavailableError } from '../ai/types.js';
import type { Deps } from '../app.js';
import { categoryExists } from './categories.js';
import { captureContext, proposeEvent } from './event.js';
import { sendError } from '../http.js';
import { findEntryByClientId, toEntry } from '../nutrition/service.js';
import { sortCapture } from './sort.js';
import {
  decodeCursor,
  deleteCapture,
  findByClientId,
  findDeletedByClientId,
  findDeletedById,
  getCapture,
  getOverview,
  insertCapture,
  listCaptures,
  toCapture,
  updateCapture,
} from './service.js';

const MAX_TEXT = 20_000;

const createSchema = z.object({
  clientId: z.uuid(),
  kind: z.enum(['text', 'link']),
  text: z.string().max(MAX_TEXT).default(''),
  url: z.string().max(2048).optional(),
  device: z.string().max(40).optional(),
  // The phone's clock (epoch ms) and IANA zone when the capture was made, for relative dates.
  capturedAt: z.number().int().optional(),
  timeZone: z.string().max(100).optional(),
  // Sent by app versions that know the Nutrition section: only they may get a Nutrition entry
  // back instead of a capture. An older cached app keeps receiving its note.
  nutrition: z.boolean().optional(),
});

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    text: z.string().max(MAX_TEXT).optional(),
    category: z.string().regex(CATEGORY_ID_RE).optional(),
    status: z.enum(['open', 'done', 'archived']).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });

const listQuery = z.object({
  status: z.enum(['open', 'done', 'archived', 'all']).default('open'),
  category: z.string().regex(CATEGORY_ID_RE).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().max(80).optional(),
});

const idParams = z.object({ id: z.uuid() });

// Groq accepts 25 MB on the free tier; ten minutes of Opus is around 1 to 2 MB.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_RECORDING_MS = 10 * 60 * 1000;

const voiceSchema = z.object({
  clientId: z.uuid(),
  durationMs: z.coerce.number().int().min(0).max(MAX_RECORDING_MS + 5_000),
  device: z.string().max(40).optional(),
  capturedAt: z.coerce.number().int().optional(),
  timeZone: z.string().max(100).optional(),
  nutrition: z.enum(['0', '1']).optional(),
});

const DELETED_MESSAGE = 'This capture was deleted. It will not be saved again.';

export function registerCaptureRoutes(app: FastifyInstance, { db, ai, foods }: Deps): void {
  app.get('/api/captures', async (req, reply) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) return sendError(reply, 400, 'invalid_input', 'Invalid list filter.');
    const before = query.data.before ? decodeCursor(query.data.before) : null;
    if (query.data.before && !before) return sendError(reply, 400, 'invalid_input', 'Invalid page cursor.');
    const statuses: CaptureStatus[] = query.data.status === 'all' ? ['open', 'done', 'archived'] : [query.data.status];
    const page = await listCaptures(db, req.user!.id, statuses, {
      limit: query.data.limit,
      before,
      category: query.data.category,
      q: query.data.q || undefined,
    });
    return { captures: page.rows.map(toCapture), nextCursor: page.nextCursor };
  });

  app.get('/api/overview', async (req) => {
    const overview = await getOverview(db, req.user!.id, 3);
    return {
      ...overview,
      sections: Object.fromEntries(Object.entries(overview.sections).map(([c, rows]) => [c, rows.map(toCapture)])),
    };
  });

  app.get('/api/captures/:id', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const row = await getCapture(db, req.user!.id, params.data.id);
    if (!row) return sendError(reply, 404, 'not_found', 'Capture not found.');
    return { capture: toCapture(row) };
  });

  app.post('/api/captures', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_input', 'This capture is not valid.');
    const input = parsed.data;
    const text = input.text.trim();

    let url: string | null = null;
    if (input.kind === 'link') {
      url = input.url ? normalizeUrl(input.url) : extractUrl(text);
      if (!url) return sendError(reply, 400, 'invalid_input', 'That does not look like a web link.');
    } else if (!text) {
      return sendError(reply, 400, 'invalid_input', 'Write something first.');
    }
    // A link note without the URL repeated reads better; keep whatever else was shared.
    const note = input.kind === 'link' && url ? removeLinkFromNote(text, url) : text;

    // Deleted for good (by hand, or once turned into a calendar event): a device that never got
    // the answer to its first upload must not bring it back. 410 is final for the device.
    if (await findDeletedByClientId(db, req.user!.id, input.clientId)) {
      return sendError(reply, 410, 'capture_deleted', DELETED_MESSAGE);
    }

    const context = captureContext(input.capturedAt, input.timeZone);
    const saved = await insertCapture(db, req.user!.id, {
      clientId: input.clientId,
      kind: input.kind,
      text: note,
      url,
      device: input.device ?? null,
      capturedAt: context.reference,
      timeZone: context.timeZone,
      // From an app that cannot show a Nutrition entry: a note for good, also for the retry
      // sweep, which would otherwise move it later where that app cannot follow.
      keptAsNote: input.nutrition !== true,
    });
    if (saved.deleted) return sendError(reply, 410, 'capture_deleted', DELETED_MESSAGE);
    // Already recognised as a meal, a workout or a weigh-in on an earlier attempt.
    if (saved.entry) return reply.code(200).send({ nutrition: toEntry(saved.entry), created: false });
    const { row, created } = saved;
    // The row is committed before the model is asked anything: a classification failure
    // can only leave the capture under Other, never lose it. The model then says what it is: a
    // note is sorted into a category, a meal, a workout or a weigh-in leaves for Nutrition. An
    // explicit calendar request is read at the same time; that step never fails the save either.
    const [sorted] = await Promise.all([
      row.classificationStatus === 'done'
        ? ({ kind: 'capture', row } as const)
        : sortCapture({ db, ai, foods }, row, { nutrition: input.nutrition === true, log: req.log }),
      proposeEvent(db, ai, row, context, req.log),
    ]);
    if (sorted.kind === 'nutrition') return reply.code(created ? 201 : 200).send({ nutrition: toEntry(sorted.row), created });
    return reply.code(created ? 201 : 200).send({ capture: toCapture(sorted.row), created });
  });

  /**
   * Voice: the audio is read into memory, sent to Groq and dropped; nothing is written to
   * disk or kept after the response. The phone keeps its own copy until it gets a 2xx.
   */
  app.post('/api/captures/voice', async (req, reply) => {
    if (!req.isMultipart()) return sendError(reply, 400, 'invalid_input', 'Expected an audio upload.');
    const fields: Record<string, string> = {};
    let audio: { buffer: Buffer; filename: string; mimeType: string } | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 10 } })) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.file.truncated) return sendError(reply, 413, 'audio_too_large', 'This recording is too long to send.');
        audio = { buffer, filename: part.filename || 'recording.webm', mimeType: part.mimetype || 'audio/webm' };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    const parsed = voiceSchema.safeParse(fields);
    if (!parsed.success) return sendError(reply, 400, 'invalid_input', 'This recording is not valid.');
    const { clientId, durationMs, device, capturedAt, timeZone } = parsed.data;
    const routesNutrition = parsed.data.nutrition === '1';

    // A retry of an upload that already went through: no second transcription, no duplicate.
    const existing = await findByClientId(db, req.user!.id, clientId);
    if (existing) return reply.code(200).send({ capture: toCapture(existing), created: false });
    const logged = await findEntryByClientId(db, req.user!.id, clientId);
    if (logged) return reply.code(200).send({ nutrition: toEntry(logged), created: false });
    if (await findDeletedByClientId(db, req.user!.id, clientId)) {
      return sendError(reply, 410, 'capture_deleted', DELETED_MESSAGE);
    }

    if (!audio || audio.buffer.length === 0) return sendError(reply, 400, 'invalid_input', 'The recording is empty.');
    if (!/^(audio|video)\//.test(audio.mimeType)) return sendError(reply, 400, 'invalid_input', 'Unsupported audio format.');

    let transcript: string;
    try {
      transcript = (await ai.transcribe({ audio: audio.buffer, filename: audio.filename, mimeType: audio.mimeType })).text;
    } catch (err) {
      // Enough to diagnose a refusal from the logs alone: what the provider said, plus what
      // was sent (size, declared type and duration), never the audio or the key.
      const upload = { bytes: audio.buffer.length, mimeType: audio.mimeType, filename: audio.filename, durationMs };
      if (err instanceof AiRejectedError) {
        req.log.warn({ provider: err.detail, upload }, 'transcription rejected');
        // Final for these bytes: a 4xx stops the phone's automatic retries; the recording
        // stays on the device, where it can be saved, retried by hand or recorded again.
        const reason = err.detail.message ? ` (${err.detail.message.slice(0, 160)})` : '';
        return sendError(reply, 422, 'transcription_rejected', `The transcription service refused this recording${reason}.`);
      }
      req.log.warn({ err: (err as Error).message, provider: (err as AiUnavailableError).detail, upload }, 'transcription failed');
      return sendError(reply, 503, 'transcription_failed', 'Transcription is unavailable right now.');
    }
    if (!transcript.trim()) {
      return sendError(reply, 422, 'empty_transcription', 'No speech was detected in this recording.');
    }

    // Deleted while it was being transcribed (an overlapping retry of an upload that went
    // through): the insert sees the tombstone under the same lock and stores nothing.
    const context = captureContext(capturedAt, timeZone);
    const saved = await insertCapture(db, req.user!.id, {
      clientId,
      kind: 'voice',
      text: transcript.trim(),
      url: null,
      durationMs,
      device: device ?? null,
      capturedAt: context.reference,
      timeZone: context.timeZone,
      keptAsNote: !routesNutrition,
    });
    if (saved.deleted) return sendError(reply, 410, 'capture_deleted', DELETED_MESSAGE);
    if (saved.entry) return reply.code(200).send({ nutrition: toEntry(saved.entry), created: false });
    const { row, created } = saved;
    const [sorted] = await Promise.all([
      row.classificationStatus === 'done'
        ? ({ kind: 'capture', row } as const)
        : sortCapture({ db, ai, foods }, row, { nutrition: routesNutrition, log: req.log }),
      proposeEvent(db, ai, row, context, req.log),
    ]);
    if (sorted.kind === 'nutrition') return reply.code(created ? 201 : 200).send({ nutrition: toEntry(sorted.row), created });
    return reply.code(created ? 201 : 200).send({ capture: toCapture(sorted.row), created });
  });

  app.patch('/api/captures/:id', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const patch = patchSchema.safeParse(req.body);
    if (!patch.success) return sendError(reply, 400, 'invalid_input', 'This change is not valid.');
    if (patch.data.category !== undefined && !(await categoryExists(db, req.user!.id, patch.data.category))) {
      return sendError(reply, 400, 'invalid_input', 'This category no longer exists.');
    }
    let row;
    try {
      row = await updateCapture(db, req.user!.id, params.data.id, patch.data);
    } catch (err) {
      // The category was deleted between the check and the write (foreign key).
      if ((err as { code?: string; cause?: { code?: string } }).code === '23503' || (err as { cause?: { code?: string } }).cause?.code === '23503')
        return sendError(reply, 400, 'invalid_input', 'This category no longer exists.');
      throw err;
    }
    if (!row) return sendError(reply, 404, 'not_found', 'Capture not found.');
    return { capture: toCapture(row) };
  });

  // Deleted for good, with its project links and its calendar proposal. An event already in
  // Google stays there. Repeating the request (lost answer) is harmless.
  app.delete('/api/captures/:id', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    if (await deleteCapture(db, req.user!.id, params.data.id)) return { deleted: true };
    if (await findDeletedById(db, req.user!.id, params.data.id)) return { deleted: true };
    return sendError(reply, 404, 'not_found', 'Capture not found.');
  });
}
