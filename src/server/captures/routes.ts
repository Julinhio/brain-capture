import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATEGORIES } from '../../shared/categories.js';
import { extractUrl, normalizeUrl, removeLinkFromNote } from '../../shared/text.js';
import type { CaptureStatus } from '../../shared/types.js';
import type { AppDeps } from '../app.js';
import { sendError } from '../http.js';
import {
  classifyCapture,
  decodeCursor,
  findByClientId,
  getCapture,
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
});

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    text: z.string().max(MAX_TEXT).optional(),
    category: z.enum(CATEGORIES).optional(),
    status: z.enum(['open', 'done', 'archived']).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });

const listQuery = z.object({
  status: z.enum(['open', 'done', 'archived', 'all']).default('open'),
  category: z.enum(CATEGORIES).optional(),
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
});

export function registerCaptureRoutes(app: FastifyInstance, { db, ai }: AppDeps): void {
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
    });
    return { captures: page.rows.map(toCapture), nextCursor: page.nextCursor };
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

    const { row, created } = await insertCapture(db, req.user!.id, {
      clientId: input.clientId,
      kind: input.kind,
      text: note,
      url,
      device: input.device ?? null,
    });
    // The row is committed before the model is asked anything: a classification failure
    // can only leave the capture under Other, never lose it.
    const final = row.classificationStatus === 'done' ? row : await classifyCapture(db, ai, row);
    return reply.code(created ? 201 : 200).send({ capture: toCapture(final), created });
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
    const { clientId, durationMs, device } = parsed.data;

    // A retry of an upload that already went through: no second transcription, no duplicate.
    const existing = await findByClientId(db, req.user!.id, clientId);
    if (existing) return reply.code(200).send({ capture: toCapture(existing), created: false });

    if (!audio || audio.buffer.length === 0) return sendError(reply, 400, 'invalid_input', 'The recording is empty.');
    if (!/^(audio|video)\//.test(audio.mimeType)) return sendError(reply, 400, 'invalid_input', 'Unsupported audio format.');

    let transcript: string;
    try {
      transcript = (await ai.transcribe({ audio: audio.buffer, filename: audio.filename, mimeType: audio.mimeType })).text;
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'transcription failed');
      return sendError(reply, 503, 'transcription_failed', 'Transcription is unavailable right now.');
    }
    if (!transcript.trim()) {
      return sendError(reply, 422, 'empty_transcription', 'No speech was detected in this recording.');
    }

    const { row, created } = await insertCapture(db, req.user!.id, {
      clientId,
      kind: 'voice',
      text: transcript.trim(),
      url: null,
      durationMs,
      device: device ?? null,
    });
    const final = row.classificationStatus === 'done' ? row : await classifyCapture(db, ai, row);
    return reply.code(created ? 201 : 200).send({ capture: toCapture(final), created });
  });

  app.patch('/api/captures/:id', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const patch = patchSchema.safeParse(req.body);
    if (!patch.success) return sendError(reply, 400, 'invalid_input', 'This change is not valid.');
    const row = await updateCapture(db, req.user!.id, params.data.id, patch.data);
    if (!row) return sendError(reply, 404, 'not_found', 'Capture not found.');
    return { capture: toCapture(row) };
  });
}
