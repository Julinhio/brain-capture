import { and, asc, eq, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATEGORIES } from '../../shared/categories.js';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/client.js';
import { captures, projects, projectCaptures, type CaptureRow } from '../db/schema.js';
import { PROJECT_STATES } from '../../shared/dashboard.js';
import { sendError } from '../http.js';

/**
 * Owner-level backup: every capture of the signed-in owner as JSON, and the matching import.
 * It lives in the app on purpose: a backup or a restore goes through HTTPS and the normal
 * session, so the database never has to be exposed outside Railway's private network.
 */
export const EXPORT_FORMAT = 'brain-capture-export';
export const EXPORT_VERSION = 1;
// Per request. Restores of any size go through in batches (scripts/lib/import-batches.mjs),
// each batch being itself a valid export file.
const IMPORT_BODY_LIMIT = 25 * 1024 * 1024;

// The import must accept anything the app itself can have stored, or a real backup could
// become unrestorable. These caps are sanity bounds well above every producer: a stored URL
// can be far longer than the 2048 characters typed (non-ASCII is percent-encoded, up to 9
// characters each), and voice transcripts are not capped like typed text.
const exportedCapture = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  kind: z.enum(['voice', 'text', 'link']),
  title: z.string().max(10_000).nullable(),
  titleManual: z.boolean(),
  text: z.string().max(1_000_000),
  originalText: z.string().max(1_000_000),
  url: z.string().max(100_000).nullable(),
  category: z.enum(CATEGORIES),
  categorySource: z.enum(['auto', 'manual', 'fallback']),
  classificationStatus: z.enum(['pending', 'done', 'failed']),
  status: z.enum(['open', 'done', 'archived']),
  durationMs: z.number().int().min(0).nullable(),
  device: z.string().max(200).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  doneAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),
});
export type ExportedCapture = z.infer<typeof exportedCapture>;

const exportFile = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.iso.datetime(),
  captures: z.array(exportedCapture).max(100_000),
  // Additive v1 extension: old capture-only files remain restorable.
  projects: z.array(z.object({ id: z.uuid(), name: z.string().min(1).max(120), intention: z.string().max(2000), state: z.enum(PROJECT_STATES), nextStep: z.string().max(500), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() })).max(100_000).default([]),
  projectLinks: z.array(z.object({ projectId: z.uuid(), captureId: z.uuid() })).max(100_000).default([]),
});

function toExported(row: CaptureRow): ExportedCapture {
  return {
    id: row.id,
    clientId: row.clientId,
    kind: row.kind,
    title: row.title,
    titleManual: row.titleManual,
    text: row.text,
    originalText: row.originalText,
    url: row.url,
    category: row.category,
    categorySource: row.categorySource,
    classificationStatus: row.classificationStatus,
    status: row.status,
    durationMs: row.durationMs,
    device: row.device,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    doneAt: row.doneAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export async function exportCaptures(db: Db, ownerId: string): Promise<ExportedCapture[]> {
  const rows = await db.select().from(captures).where(eq(captures.ownerId, ownerId)).orderBy(asc(captures.createdAt), asc(captures.id));
  return rows.map(toExported);
}

/**
 * Adds the captures that are missing and leaves everything else alone: an existing capture
 * (same id, or same clientId for this owner) is never overwritten, nothing is deleted.
 * Running the same file twice is therefore harmless.
 */
export async function importCaptures(db: Db, ownerId: string, items: ExportedCapture[]): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  for (const c of items) {
    const result = await db
      .insert(captures)
      .values({
        id: c.id,
        ownerId,
        clientId: c.clientId,
        kind: c.kind,
        title: c.title,
        titleManual: c.titleManual,
        text: c.text,
        originalText: c.originalText,
        url: c.url,
        category: c.category,
        categorySource: c.categorySource,
        classificationStatus: c.classificationStatus,
        classificationAttempts: 0,
        status: c.status,
        durationMs: c.durationMs,
        device: c.device,
        createdAt: new Date(c.createdAt),
        updatedAt: new Date(c.updatedAt),
        doneAt: c.doneAt ? new Date(c.doneAt) : null,
        archivedAt: c.archivedAt ? new Date(c.archivedAt) : null,
      })
      .onConflictDoNothing()
      .returning({ id: captures.id });
    inserted += result.length;
  }
  return { inserted, skipped: items.length - inserted };
}

export function registerBackupRoutes(app: FastifyInstance, { db, config }: AppDeps): void {
  app.get('/api/export', async (req, reply) => {
    const exportedAt = new Date().toISOString();
    const body = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt,
      appVersion: config.appVersion,
      captures: await exportCaptures(db, req.user!.id),
      projects: (await db.select().from(projects).where(eq(projects.ownerId, req.user!.id)).orderBy(asc(projects.createdAt), asc(projects.id))).map(({ ownerId: _owner, createdAt, updatedAt, ...p }) => ({ ...p, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() })),
      projectLinks: await db.select({ projectId: projectCaptures.projectId, captureId: projectCaptures.captureId }).from(projectCaptures)
        .innerJoin(projects, eq(projects.id, projectCaptures.projectId)).innerJoin(captures, eq(captures.id, projectCaptures.captureId))
        .where(and(eq(projects.ownerId, req.user!.id), eq(captures.ownerId, req.user!.id)))
        .orderBy(asc(projectCaptures.projectId), asc(projectCaptures.captureId)),
    };
    if ((req.query as { download?: string }).download === '1') {
      const stamp = exportedAt.slice(0, 16).replace(/[:T]/g, '-');
      reply.header('Content-Disposition', `attachment; filename="brain-capture-${stamp}.json"`);
    }
    reply.header('Cache-Control', 'no-store');
    return body;
  });

  app.post('/api/import', { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const parsed = exportFile.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_input', 'This is not a Brain Capture backup file.');
    const ownerId = req.user!.id;
    const result = await db.transaction(async (tx) => {
      const result = await importCaptures(tx as unknown as Db, ownerId, parsed.data.captures);
      for (const p of parsed.data.projects) {
        await tx.insert(projects).values({ ...p, ownerId, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt) }).onConflictDoNothing();
      }
      for (const link of parsed.data.projectLinks) {
        const [project] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, link.projectId), eq(projects.ownerId, ownerId)));
        const original = parsed.data.captures.find((c) => c.id === link.captureId);
        const [capture] = await tx.select({ id: captures.id }).from(captures).where(and(eq(captures.ownerId, ownerId), original ? or(eq(captures.id, link.captureId), eq(captures.clientId, original.clientId)) : eq(captures.id, link.captureId)));
        if (project && capture) await tx.insert(projectCaptures).values({ projectId: project.id, captureId: capture.id }).onConflictDoNothing();
      }
      return result;
    });
    return { ...result, total: parsed.data.captures.length };
  });
}
