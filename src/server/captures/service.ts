import { and, desc, eq, gt, ilike, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { OTHER, type Category } from '../../shared/categories.js';
import { fallbackTitle } from '../../shared/text.js';
import type { Capture, CaptureKind, CaptureStatus } from '../../shared/types.js';
import type { Ai } from '../ai/types.js';
import type { Db } from '../db/client.js';
import { captures, deletedCaptures, type CaptureRow, type DeletedCaptureRow } from '../db/schema.js';
import { listCategories } from './categories.js';

export const MAX_CLASSIFICATION_ATTEMPTS = 3;

export function toCapture(row: CaptureRow): Capture {
  return {
    id: row.id,
    clientId: row.clientId,
    kind: row.kind,
    title: row.title,
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

export interface NewCapture {
  clientId: string;
  kind: CaptureKind;
  text: string;
  url: string | null;
  durationMs?: number | null;
  device?: string | null;
}

/**
 * Inserts once per (owner, clientId). A retry of an upload that already succeeded gets the
 * stored row back instead of a duplicate, which is what makes "retry" safe on the phone.
 */
export async function insertCapture(db: Db, ownerId: string, input: NewCapture): Promise<{ row: CaptureRow; created: boolean }> {
  const inserted = await db
    .insert(captures)
    .values({
      ownerId,
      clientId: input.clientId,
      kind: input.kind,
      text: input.text,
      originalText: input.text,
      url: input.url,
      title: fallbackTitle(input.text, input.url),
      durationMs: input.durationMs ?? null,
      device: input.device ?? null,
    })
    .onConflictDoNothing({ target: [captures.ownerId, captures.clientId] })
    .returning();
  if (inserted[0]) return { row: inserted[0], created: true };

  const existing = await findByClientId(db, ownerId, input.clientId);
  if (!existing) throw new Error('Capture conflict without an existing row');
  return { row: existing, created: false };
}

/** A capture deleted for good, looked up by the id the device gave it. */
export async function findDeletedByClientId(db: Db, ownerId: string, clientId: string): Promise<DeletedCaptureRow | null> {
  const [row] = await db
    .select()
    .from(deletedCaptures)
    .where(and(eq(deletedCaptures.ownerId, ownerId), eq(deletedCaptures.clientId, clientId)))
    .limit(1);
  return row ?? null;
}

export async function findDeletedById(db: Db, ownerId: string, captureId: string): Promise<DeletedCaptureRow | null> {
  const [row] = await db
    .select()
    .from(deletedCaptures)
    .where(and(eq(deletedCaptures.ownerId, ownerId), eq(deletedCaptures.captureId, captureId)))
    .limit(1);
  return row ?? null;
}

/**
 * Deletes a capture for good, with its project links and its calendar proposal (cascades),
 * and leaves a tombstone so it cannot come back on its own: a device resending it gets a
 * "deleted" answer instead of a new row. An event already in Google is not touched.
 * Returns false when there was nothing to delete.
 */
export async function deleteCapture(
  db: Db,
  ownerId: string,
  id: string,
  reason: DeletedCaptureRow['reason'] = 'deleted',
  calendarEvent: DeletedCaptureRow['calendarEvent'] = null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(captures)
      .where(and(eq(captures.ownerId, ownerId), eq(captures.id, id)))
      .returning({ id: captures.id, clientId: captures.clientId });
    if (!row) return false;
    await tx
      .insert(deletedCaptures)
      .values({ captureId: row.id, ownerId, clientId: row.clientId, reason, calendarEvent })
      .onConflictDoNothing();
    return true;
  });
}

export async function findByClientId(db: Db, ownerId: string, clientId: string): Promise<CaptureRow | null> {
  const [row] = await db
    .select()
    .from(captures)
    .where(and(eq(captures.ownerId, ownerId), eq(captures.clientId, clientId)))
    .limit(1);
  return row ?? null;
}

export async function getCapture(db: Db, ownerId: string, id: string): Promise<CaptureRow | null> {
  const [row] = await db
    .select()
    .from(captures)
    .where(and(eq(captures.ownerId, ownerId), eq(captures.id, id)))
    .limit(1);
  return row ?? null;
}

export interface PageCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(row: Pick<CaptureRow, 'createdAt' | 'id'>): string {
  return `${row.createdAt.toISOString()}_${row.id}`;
}

export function decodeCursor(raw: string): PageCursor | null {
  const [iso, id] = raw.split('_');
  if (!iso || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const createdAt = new Date(iso);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

/**
 * Newest first, keyset-paginated on (created_at, id) so nothing is skipped or repeated when
 * two captures share a timestamp or new ones arrive between pages.
 */
export async function listCaptures(
  db: Db,
  ownerId: string,
  statuses: CaptureStatus[],
  { limit, before, category, q }: { limit: number; before?: PageCursor | null; category?: Category; q?: string },
): Promise<{ rows: CaptureRow[]; nextCursor: string | null }> {
  const pattern = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await db
    .select()
    .from(captures)
    .where(
      and(
        eq(captures.ownerId, ownerId),
        inArray(captures.status, statuses),
        category ? eq(captures.category, category) : undefined,
        pattern ? or(ilike(captures.title, pattern), ilike(captures.text, pattern), ilike(captures.url, pattern)) : undefined,
        before
          ? or(lt(captures.createdAt, before.createdAt), and(eq(captures.createdAt, before.createdAt), lt(captures.id, before.id)))
          : undefined,
      ),
    )
    .orderBy(desc(captures.createdAt), desc(captures.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

export interface Overview {
  /** One entry per category of the owner, open captures only. */
  counts: Record<Category, number>;
  done: number;
  archived: number;
  /** Open captures created in the last 24 hours. */
  recent: number;
  sections: Record<Category, CaptureRow[]>;
}

/** Everything the desktop home needs in one round trip: counts plus the latest few per category. */
export async function getOverview(db: Db, ownerId: string, perCategory: number, now = new Date()): Promise<Overview> {
  const grouped = await db
    .select({ status: captures.status, category: captures.category, n: sql<number>`count(*)::int` })
    .from(captures)
    .where(eq(captures.ownerId, ownerId))
    .groupBy(captures.status, captures.category);
  const [recentRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(captures)
    .where(
      and(eq(captures.ownerId, ownerId), eq(captures.status, 'open'), gt(captures.createdAt, new Date(now.getTime() - 86_400_000))),
    );

  const ids = (await listCategories(db, ownerId)).map((c) => c.id);
  const counts = Object.fromEntries(ids.map((c) => [c, 0])) as Record<Category, number>;
  let done = 0;
  let archived = 0;
  for (const g of grouped) {
    if (g.status === 'open') counts[g.category] = (counts[g.category] ?? 0) + g.n;
    else if (g.status === 'done') done += g.n;
    else archived += g.n;
  }

  const sections = Object.fromEntries(
    await Promise.all(
      ids.map(async (category) => {
        const page = await listCaptures(db, ownerId, ['open'], { limit: perCategory, category });
        return [category, page.rows] as const;
      }),
    ),
  ) as Record<Category, CaptureRow[]>;

  return { counts, done, archived, recent: recentRow?.n ?? 0, sections };
}

/**
 * Asks the model for a category and title. Any failure leaves the capture saved and
 * findable under Other; the sweeper retries a few times. A category or title Julien set
 * by hand is never overwritten.
 */
export async function classifyCapture(db: Db, ai: Ai, row: CaptureRow): Promise<CaptureRow> {
  // No key configured yet: leave it pending so it is sorted once a key is added.
  if (!ai.available) return row;
  const [attempt] = await db
    .update(captures)
    .set({ classificationAttempts: sql`${captures.classificationAttempts} + 1` })
    .where(and(eq(captures.id, row.id), ne(captures.classificationStatus, 'done')))
    .returning();
  if (!attempt) return (await getCapture(db, row.ownerId, row.id)) ?? row;

  try {
    // The owner's categories as they are now: a category added a minute ago is a valid answer.
    const options = await listCategories(db, attempt.ownerId);
    const result = await ai.classify({ kind: attempt.kind, text: attempt.text, url: attempt.url, categories: options });
    // A category deleted while the model was answering would break the foreign key: the
    // attempt then fails like any other and the sweeper asks again with the current list.
    const [updated] = await db
      .update(captures)
      .set({
        classificationStatus: 'done',
        category: sql`case when ${captures.categorySource} = 'manual' then ${captures.category} else ${result.category} end`,
        categorySource: sql`case when ${captures.categorySource} = 'manual' then ${captures.categorySource} else 'auto'::category_source end`,
        title: sql`case when ${captures.titleManual} then ${captures.title} else ${result.title} end`,
      })
      .where(eq(captures.id, attempt.id))
      .returning();
    return updated ?? attempt;
  } catch {
    const [updated] = await db
      .update(captures)
      .set({ classificationStatus: 'failed' })
      .where(and(eq(captures.id, attempt.id), ne(captures.classificationStatus, 'done')))
      .returning();
    return updated ?? attempt;
  }
}

export interface CapturePatch {
  title?: string;
  text?: string;
  category?: Category;
  status?: CaptureStatus;
}

export async function updateCapture(db: Db, ownerId: string, id: string, patch: CapturePatch): Promise<CaptureRow | null> {
  const now = new Date();
  const set: Partial<typeof captures.$inferInsert> = { updatedAt: now };
  if (patch.title !== undefined) {
    set.title = patch.title;
    set.titleManual = true;
  }
  if (patch.text !== undefined) set.text = patch.text;
  if (patch.category !== undefined) {
    set.category = patch.category;
    set.categorySource = 'manual';
  }
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.doneAt = patch.status === 'done' ? now : null;
    set.archivedAt = patch.status === 'archived' ? now : null;
  }
  const [row] = await db
    .update(captures)
    .set(set)
    .where(and(eq(captures.ownerId, ownerId), eq(captures.id, id)))
    .returning();
  return row ?? null;
}

/** Captures whose classification is still owed, across owners (the sweeper is server-side). */
export async function pendingClassifications(db: Db, olderThan: Date, limit: number): Promise<CaptureRow[]> {
  return db
    .select()
    .from(captures)
    .where(
      and(
        ne(captures.classificationStatus, 'done'),
        lt(captures.classificationAttempts, MAX_CLASSIFICATION_ATTEMPTS),
        lt(captures.updatedAt, olderThan),
      ),
    )
    .orderBy(captures.createdAt)
    .limit(limit);
}
