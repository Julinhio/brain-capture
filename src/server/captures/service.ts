import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Category } from '../../shared/categories.js';
import { fallbackTitle } from '../../shared/text.js';
import type { Capture, CaptureKind, CaptureStatus } from '../../shared/types.js';
import type { Ai } from '../ai/types.js';
import type { Db } from '../db/client.js';
import { captures, type CaptureRow } from '../db/schema.js';

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

export async function listCaptures(db: Db, ownerId: string, statuses: CaptureStatus[], limit = 500): Promise<CaptureRow[]> {
  return db
    .select()
    .from(captures)
    .where(and(eq(captures.ownerId, ownerId), inArray(captures.status, statuses)))
    .orderBy(desc(captures.createdAt))
    .limit(limit);
}

/**
 * Asks the model for a category and title. Any failure leaves the capture saved and
 * findable under Other; the sweeper retries a few times. A category or title Julien set
 * by hand is never overwritten.
 */
export async function classifyCapture(db: Db, ai: Ai, row: CaptureRow): Promise<CaptureRow> {
  const [attempt] = await db
    .update(captures)
    .set({ classificationAttempts: sql`${captures.classificationAttempts} + 1` })
    .where(and(eq(captures.id, row.id), ne(captures.classificationStatus, 'done')))
    .returning();
  if (!attempt) return (await getCapture(db, row.ownerId, row.id)) ?? row;

  try {
    const result = await ai.classify({ kind: attempt.kind, text: attempt.text, url: attempt.url });
    const [updated] = await db
      .update(captures)
      .set({
        classificationStatus: 'done',
        category: sql`case when ${captures.categorySource} = 'manual' then ${captures.category} else ${result.category}::category end`,
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
