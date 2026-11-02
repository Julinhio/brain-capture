import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATEGORIES } from '../../shared/categories.js';
import { extractUrl, normalizeUrl, stripUrls } from '../../shared/text.js';
import type { CaptureStatus } from '../../shared/types.js';
import type { AppDeps } from '../app.js';
import { sendError } from '../http.js';
import { classifyCapture, getCapture, insertCapture, listCaptures, toCapture, updateCapture } from './service.js';

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
});

const idParams = z.object({ id: z.uuid() });

export function registerCaptureRoutes(app: FastifyInstance, { db, ai }: AppDeps): void {
  app.get('/api/captures', async (req, reply) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) return sendError(reply, 400, 'invalid_input', 'Unknown status filter.');
    const statuses: CaptureStatus[] = query.data.status === 'all' ? ['open', 'done', 'archived'] : [query.data.status];
    const rows = await listCaptures(db, req.user!.id, statuses);
    return { captures: rows.map(toCapture) };
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
    const note = input.kind === 'link' ? stripUrls(text) : text;

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
