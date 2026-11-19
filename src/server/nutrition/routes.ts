import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_KCAL_GOAL,
  MAX_TITLE,
  MAX_WEIGHT_KG,
  MIN_KCAL_GOAL,
  MIN_WEIGHT_KG,
  cleanData,
  dataProblem,
  defaultTitle,
  isDay,
  localDay,
  round1,
  shiftDay,
  type MealData,
  type NutritionEntry,
} from '../../shared/nutrition.js';
import { isValidTimeZone } from '../../shared/event.js';
import { AiRejectedError, type AiUnavailableError } from '../ai/types.js';
import type { Deps } from '../app.js';
import { captureContext, proposeEvent } from '../captures/event.js';
import { findByClientId, findDeletedByClientId, findDeletedById, getCapture, insertCapture, toCapture } from '../captures/service.js';
import { sortCapture, whenOf } from '../captures/sort.js';
import { sendError } from '../http.js';
import {
  buildEntry,
  deleteEntry,
  findEntryByClientId,
  getDay,
  getEntry,
  getHistory,
  getPhoto,
  getSettings,
  moveCaptureToNutrition,
  moveEntryToNote,
  setGoal,
  storeEntry,
  toEntry,
  updateEntry,
  type EntryPatch,
} from './service.js';

// The picture sent for analysis is resized on the phone (about 1280 px, a few hundred KB);
// this bound only stops a client that would not. The thumbnail is all that is ever stored.
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_THUMB_BYTES = 150 * 1024;
const MAX_HISTORY_DAYS = 400;
const MAX_TEXT = 4000;
const DELETED_MESSAGE = 'This entry was deleted. It will not be saved again.';
const NOT_NUTRITION = 'No meal, workout or weight could be read in this.';

/** The image type, from its first bytes: the declared type is the client's word only. */
export function sniffImage(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const idParams = z.object({ id: z.uuid() });
const photoFields = z.object({
  clientId: z.uuid(),
  caption: z.string().max(1000).optional(),
  device: z.string().max(40).optional(),
  capturedAt: z.coerce.number().int().optional(),
  timeZone: z.string().max(100).optional(),
});
const patchSchema = z
  .object({
    status: z.literal('confirmed').optional(),
    title: z.string().trim().min(1).max(MAX_TITLE).optional(),
    day: z.string().refine(isDay).optional(),
    data: z.unknown().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0);
const createSchema = z
  .object({
    clientId: z.uuid(),
    text: z.string().trim().min(1).max(MAX_TEXT).optional(),
    weightKg: z.number().min(MIN_WEIGHT_KG).max(MAX_WEIGHT_KG).optional(),
    day: z.string().refine(isDay).optional(),
    capturedAt: z.number().int().optional(),
    timeZone: z.string().max(100).optional(),
  })
  .strict()
  .refine((b) => (b.text === undefined) !== (b.weightKg === undefined));

export function registerNutritionRoutes(app: FastifyInstance, { db, ai, foods }: Deps): void {
  const respond = (row: Parameters<typeof toEntry>[0]): { nutrition: NutritionEntry } => ({ nutrition: toEntry(row) });

  /**
   * Photo: read by the vision model in memory and dropped; only the small thumbnail the phone
   * made is kept, with the entry. A meal, a scale or a workout screen becomes a Nutrition
   * entry to confirm. Anything else becomes a note holding what can be read in the picture.
   */
  app.post('/api/captures/photo', async (req, reply) => {
    if (!req.isMultipart()) return sendError(reply, 400, 'invalid_input', 'Expected a photo upload.');
    const fields: Record<string, string> = {};
    let image: Buffer | null = null;
    let thumb: Buffer | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_IMAGE_BYTES, files: 2, fields: 10 } })) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.file.truncated) return sendError(reply, 413, 'image_too_large', 'This photo is too large to send.');
        if (part.fieldname === 'image') image = buffer;
        else if (part.fieldname === 'thumb') thumb = buffer;
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    const parsed = photoFields.safeParse(fields);
    if (!parsed.success) return sendError(reply, 400, 'invalid_input', 'This photo is not valid.');
    const { clientId, device, capturedAt, timeZone } = parsed.data;
    const caption = (parsed.data.caption ?? '').trim();
    const ownerId = req.user!.id;

    // A retry of an upload that already went through: no second analysis, no duplicate.
    const stored = await findEntryByClientId(db, ownerId, clientId);
    if (stored) return reply.code(200).send({ ...respond(stored), created: false });
    const note = await findByClientId(db, ownerId, clientId);
    if (note) return reply.code(200).send({ capture: toCapture(note), created: false });
    if (await findDeletedByClientId(db, ownerId, clientId)) return sendError(reply, 410, 'capture_deleted', DELETED_MESSAGE);

    const mimeType = image ? sniffImage(image) : null;
    if (!image || !mimeType) return sendError(reply, 400, 'invalid_input', 'This file is not a photo (JPEG, PNG or WebP).');
    const thumbType = thumb && thumb.length <= MAX_THUMB_BYTES ? sniffImage(thumb) : null;

    const when = captureContext(capturedAt, timeZone);
    let extraction;
    try {
      extraction = await ai.readPhoto({ image, mimeType, caption, ...when });
    } catch (err) {
      const upload = { bytes: image.length, mimeType };
      if (err instanceof AiRejectedError) {
        req.log.warn({ provider: err.detail, upload }, 'photo rejected');
        const reason = err.detail.message ? ` (${err.detail.message.slice(0, 160)})` : '';
        return sendError(reply, 422, 'photo_rejected', `The photo could not be read${reason}.`);
      }
      req.log.warn({ err: (err as Error).message, provider: (err as AiUnavailableError).detail, upload }, 'photo reading failed');
      return sendError(reply, 503, 'photo_failed', 'Photo reading is unavailable right now.');
    }

    const built = await buildEntry(db, foods, ownerId, extraction, when);
    if (built) {
      const saved = await storeEntry(db, ownerId, {
        ...built,
        clientId,
        status: 'proposed',
        source: 'photo',
        originalText: [caption, extraction.description].filter(Boolean).join('\n'),
        when,
        device: device ?? null,
        photo: thumb && thumbType ? { mimeType: thumbType, bytes: thumb } : null,
      });
      if (saved.kind === 'deleted') return sendError(reply, 410, 'capture_deleted', DELETED_MESSAGE);
      if (saved.kind === 'capture') return reply.code(200).send({ capture: toCapture(saved.row), created: false });
      return reply.code(saved.created ? 201 : 200).send({ ...respond(saved.row), created: saved.created });
    }

    // Not for Nutrition: a note with his sentence and what the picture says. The image itself
    // is not kept on notes.
    const seen = extraction.text || (extraction.description ? `Photo: ${extraction.description}` : '');
    const text = [caption, seen].filter(Boolean).join('\n\n').slice(0, 20_000);
    if (!text) return sendError(reply, 422, 'photo_rejected', 'Nothing could be read in this photo.');
    const saved = await insertCapture(db, ownerId, {
      clientId,
      kind: 'text',
      text,
      url: null,
      device: device ?? null,
      capturedAt: when.reference,
      timeZone: when.timeZone,
      keptAsNote: true,
    });
    if (saved.deleted) return sendError(reply, 410, 'capture_deleted', DELETED_MESSAGE);
    if (saved.entry) return reply.code(200).send({ ...respond(saved.entry), created: false });
    const [sorted] = await Promise.all([
      sortCapture({ db, ai, foods }, saved.row, { nutrition: false, log: req.log }),
      proposeEvent(db, ai, saved.row, when, req.log),
    ]);
    return reply.code(saved.created ? 201 : 200).send({ capture: toCapture(sorted.row as Parameters<typeof toCapture>[0]), created: saved.created });
  });

  app.get('/api/nutrition/day', async (req, reply) => {
    const query = z.object({ day: z.string().optional(), timeZone: z.string().max(100).optional() }).safeParse(req.query);
    if (!query.success || (query.data.day !== undefined && !isDay(query.data.day))) return sendError(reply, 400, 'invalid_input', 'Invalid day.');
    const zone = query.data.timeZone && isValidTimeZone(query.data.timeZone) ? query.data.timeZone : 'Europe/Paris';
    return getDay(db, req.user!.id, query.data.day ?? localDay(new Date(), zone));
  });

  app.get('/api/nutrition/history', async (req, reply) => {
    const query = z.object({ from: z.string().refine(isDay), to: z.string().refine(isDay) }).safeParse(req.query);
    if (!query.success || query.data.from > query.data.to) return sendError(reply, 400, 'invalid_input', 'Invalid period.');
    if (shiftDay(query.data.from, MAX_HISTORY_DAYS) < query.data.to) return sendError(reply, 400, 'invalid_input', 'This period is too long.');
    return getHistory(db, req.user!.id, query.data.from, query.data.to);
  });

  app.get('/api/nutrition/settings', async (req) => getSettings(db, req.user!.id));

  app.put('/api/nutrition/settings', async (req, reply) => {
    const body = z.object({ kcalGoal: z.number().int().min(MIN_KCAL_GOAL).max(MAX_KCAL_GOAL) }).strict().safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', `Choose a goal between ${MIN_KCAL_GOAL} and ${MAX_KCAL_GOAL} kcal.`);
    return setGoal(db, req.user!.id, body.data.kcalGoal);
  });

  /**
   * Straight into Nutrition, from the section itself: a weight typed by hand (counted at once),
   * or a sentence read as a meal, a workout or a weight (to confirm, like a capture).
   */
  app.post('/api/nutrition/entries', async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', 'This entry is not valid.');
    const input = body.data;
    const ownerId = req.user!.id;
    const when = captureContext(input.capturedAt, input.timeZone);
    const today = localDay(when.reference, when.timeZone);
    if (input.day && input.day > today) return sendError(reply, 400, 'invalid_input', 'This day has not happened yet.');

    const stored = await findEntryByClientId(db, ownerId, input.clientId);
    if (stored) return reply.code(200).send({ ...respond(stored), created: false });
    if (await findDeletedByClientId(db, ownerId, input.clientId)) return sendError(reply, 410, 'capture_deleted', DELETED_MESSAGE);

    let entry;
    if (input.weightKg !== undefined) {
      const data = { kg: round1(input.weightKg) };
      entry = { type: 'weight' as const, title: defaultTitle('weight', data), day: input.day ?? today, data, status: 'confirmed' as const, source: 'manual' as const, originalText: '' };
    } else {
      let built;
      try {
        if (!ai.available) throw new Error('No AI provider configured');
        built = await buildEntry(db, foods, ownerId, await ai.extractNutrition({ text: input.text!, ...when }), when, input.day);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'nutrition reading failed');
        return sendError(reply, 503, 'internal', 'Automatic reading is unavailable right now. Try again in a moment.');
      }
      if (!built) return sendError(reply, 422, 'not_nutrition', NOT_NUTRITION);
      entry = { ...built, status: 'proposed' as const, source: 'text' as const, originalText: input.text! };
    }
    const saved = await storeEntry(db, ownerId, { ...entry, clientId: input.clientId, when });
    if (saved.kind === 'deleted') return sendError(reply, 410, 'capture_deleted', DELETED_MESSAGE);
    if (saved.kind === 'capture') return sendError(reply, 400, 'invalid_input', 'This entry already exists as a note.');
    return reply.code(saved.created ? 201 : 200).send({ ...respond(saved.row), created: saved.created });
  });

  /** Foods read from a few words ("1 yaourt nature, une pomme"), to add to a meal card. Stores nothing. */
  app.post('/api/nutrition/estimate', async (req, reply) => {
    const body = z.object({ text: z.string().trim().min(1).max(500) }).strict().safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', 'Say which food to add.');
    const when = captureContext(undefined, undefined);
    try {
      if (!ai.available) throw new Error('No AI provider configured');
      const extraction = await ai.extractNutrition({ text: body.data.text, ...when });
      const built = extraction.items.length ? await buildEntry(db, foods, req.user!.id, { ...extraction, type: 'meal' }, when) : null;
      if (!built) return sendError(reply, 422, 'not_nutrition', 'No food could be read in this.');
      return { items: (built.data as MealData).items };
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'food estimate failed');
      return sendError(reply, 503, 'internal', 'Automatic reading is unavailable right now. Fill in the values by hand.');
    }
  });

  app.get('/api/nutrition/entries/:id', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const row = params.success ? await getEntry(db, req.user!.id, params.data.id) : null;
    if (!row) return sendError(reply, 404, 'not_found', 'Entry not found.');
    return respond(row);
  });

  // The thumbnail never changes for an entry: the browser may keep it.
  app.get('/api/nutrition/entries/:id/photo', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const photo = params.success ? await getPhoto(db, req.user!.id, params.data.id) : null;
    if (!photo) return sendError(reply, 404, 'not_found', 'No photo for this entry.');
    return reply
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .type(photo.mimeType)
      .send(photo.bytes);
  });

  /** Edits from the card, and the one-tap confirmation that makes the entry count. */
  app.patch('/api/nutrition/entries/:id', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Entry not found.');
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', 'This change is not valid.');
    const current = await getEntry(db, req.user!.id, params.data.id);
    if (!current) return sendError(reply, 404, 'not_found', 'Entry not found.');

    const patch: EntryPatch = {};
    if (body.data.data !== undefined) {
      const data = cleanData(current.type, body.data.data);
      if (!data) return sendError(reply, 400, 'invalid_input', 'These values are not valid.');
      patch.data = data;
    }
    if (body.data.title !== undefined) patch.title = body.data.title;
    if (body.data.day !== undefined) {
      // Nothing is eaten tomorrow. The latest "today" anywhere (UTC+14) is the bound, so a
      // phone ahead of the server is never refused its own today.
      if (body.data.day > localDay(new Date(), 'Pacific/Kiritimati')) return sendError(reply, 400, 'invalid_input', 'This day has not happened yet.');
      patch.day = body.data.day;
    }
    if (body.data.status) {
      const problem = dataProblem(current.type, patch.data ?? current.data);
      if (problem) return sendError(reply, 400, 'invalid_input', problem);
      patch.status = 'confirmed';
    }
    // A weigh-in is named after its value.
    if (current.type === 'weight' && patch.data) patch.title = defaultTitle('weight', patch.data);
    const row = await updateEntry(db, req.user!.id, params.data.id, patch);
    if (!row) return sendError(reply, 404, 'not_found', 'Entry not found.');
    return respond(row);
  });

  // Repeating the request (lost answer) is harmless.
  app.delete('/api/nutrition/entries/:id', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Entry not found.');
    if (await deleteEntry(db, req.user!.id, params.data.id)) return { deleted: true };
    if (await findDeletedById(db, req.user!.id, params.data.id)) return { deleted: true };
    return sendError(reply, 404, 'not_found', 'Entry not found.');
  });

  /** "It's a note": the detection was wrong. The entry becomes the note it should have been. */
  app.post('/api/nutrition/entries/:id/note', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Entry not found.');
    const moved = await moveEntryToNote(db, req.user!.id, params.data.id);
    if (!moved) {
      // Tapped twice, or the answer was lost: the note is already there.
      const already = await getCapture(db, req.user!.id, params.data.id);
      if (already) return { capture: toCapture(already) };
      return sendError(reply, 404, 'not_found', 'Entry not found.');
    }
    const sorted = await sortCapture({ db, ai, foods }, moved, { nutrition: false, log: req.log });
    return { capture: toCapture(sorted.row as Parameters<typeof toCapture>[0]) };
  });

  /** The other way round: a note the detection left among the notes. */
  app.post('/api/captures/:id/nutrition', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Capture not found.');
    const capture = await getCapture(db, req.user!.id, params.data.id);
    if (!capture) {
      const already = await getEntry(db, req.user!.id, params.data.id);
      if (already) return respond(already);
      return sendError(reply, 404, 'not_found', 'Capture not found.');
    }
    const when = whenOf(capture);
    let built;
    try {
      if (!ai.available) throw new Error('No AI provider configured');
      built = await buildEntry(db, foods, req.user!.id, await ai.extractNutrition({ text: capture.text, ...when }), when);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'nutrition reading failed');
      return sendError(reply, 503, 'internal', 'Automatic reading is unavailable right now. Try again in a moment.');
    }
    if (!built) return sendError(reply, 422, 'not_nutrition', NOT_NUTRITION);
    const entry = await moveCaptureToNutrition(db, capture, built, when, { force: true });
    if (!entry) return sendError(reply, 404, 'not_found', 'Capture not found.');
    return respond(entry);
  });
}
