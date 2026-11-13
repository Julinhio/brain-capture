import { and, asc, eq, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATEGORY_ID_RE, DEFAULT_CATEGORIES, OTHER } from '../../shared/categories.js';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/client.js';
import { captures, categories, deletedCaptures, projects, projectCaptures, type CaptureRow } from '../db/schema.js';
import { lockClientId } from '../captures/service.js';
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
  // Any id: a backup can name a category deleted since, which then restores under Other.
  category: z.string().regex(CATEGORY_ID_RE),
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
  // Additive too: files from before editable categories have none, their captures use the
  // original ids, which every account starts with.
  categories: z
    .array(
      z.object({
        id: z.string().regex(CATEGORY_ID_RE),
        name: z.string().trim().min(1).max(200),
        description: z.string().max(5000),
        color: z.string().max(40).nullable(),
        position: z.number().int(),
      }),
    )
    .max(1000)
    .default([]),
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
 * Running the same file twice is therefore harmless. A capture deleted for good since the
 * backup stays deleted, and one whose category no longer exists lands in Other.
 */
export async function importCaptures(
  db: Db,
  ownerId: string,
  items: ExportedCapture[],
): Promise<{ inserted: number; skipped: number; deleted: number }> {
  const known = new Set(
    (await db.select({ id: categories.id }).from(categories).where(eq(categories.ownerId, ownerId))).map((c) => c.id),
  );
  let inserted = 0;
  let deleted = 0;
  for (const c of items) {
    // Same lock as a deletion, then the tombstone check: a capture deleted while this restore
    // runs is seen here, and one deleted before is never brought back.
    await lockClientId(db, ownerId, c.clientId);
    const [gone] = await db
      .select({ id: deletedCaptures.captureId })
      .from(deletedCaptures)
      .where(and(eq(deletedCaptures.ownerId, ownerId), or(eq(deletedCaptures.captureId, c.id), eq(deletedCaptures.clientId, c.clientId))))
      .limit(1);
    if (gone) {
      deleted += 1;
      continue;
    }
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
        category: known.has(c.category) ? c.category : OTHER,
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
  return { inserted, skipped: items.length - inserted - deleted, deleted };
}

type ExportedCategory = z.infer<typeof exportFile>['categories'][number];

/**
 * Categories first, so the captures find theirs. A category already there (same id) is left as
 * it is, with one exception: a starting category nobody has edited yet (a fresh account) takes
 * the backup's name and description, so a restore after losing the database brings back the
 * renamed ones, even when they swapped names with each other ("Jobs" ↔ "Learning").
 * Names are unique per account, so this goes in three steps: the starting categories about to
 * be renamed let go of their names, the missing categories are added, then the names are set.
 */
async function restoreCategories(tx: Db, ownerId: string, items: ExportedCategory[]): Promise<void> {
  const current = await tx.select().from(categories).where(eq(categories.ownerId, ownerId));
  const values = (c: ExportedCategory) => ({ name: c.name.slice(0, 40), description: c.description.slice(0, 400) });
  const renames = items.filter((c) => {
    const start = DEFAULT_CATEGORIES.find((d) => d.id === c.id);
    const row = current.find((r) => r.id === c.id);
    if (!start || !row || c.id === OTHER) return false;
    const untouched = row.name === start.name && row.description === start.description;
    const v = values(c);
    return untouched && (v.name !== row.name || v.description !== row.description);
  });
  const own = (id: string) => and(eq(categories.ownerId, ownerId), eq(categories.id, id));
  for (const c of renames) await tx.update(categories).set({ name: `restoring:${c.id}` }).where(own(c.id));
  for (const c of items) {
    if (current.some((r) => r.id === c.id)) continue;
    await tx
      .insert(categories)
      .values({ ownerId, id: c.id, ...values(c), color: c.color, position: c.position })
      .onConflictDoNothing();
  }
  for (const c of renames) {
    const start = DEFAULT_CATEGORIES.find((d) => d.id === c.id)!;
    // The backup's name, else (taken by a category the account already had) the original one,
    // else a name that cannot clash. Each try in its own savepoint.
    const tries = [values(c), { name: start.name, description: start.description }, { name: `${start.name} (${c.id})`, description: start.description }];
    for (const attempt of tries) {
      const ok = await tx
        .transaction(async (step) => {
          await step.update(categories).set({ ...attempt, updatedAt: new Date() }).where(own(c.id));
        })
        .then(() => true)
        .catch(() => false);
      if (ok) break;
    }
  }
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
      categories: (await db.select().from(categories).where(eq(categories.ownerId, req.user!.id)).orderBy(asc(categories.position), asc(categories.id))).map(
        ({ id, name, description, color, position }) => ({ id, name, description, color, position }),
      ),
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
      await restoreCategories(tx as unknown as Db, ownerId, parsed.data.categories);
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
