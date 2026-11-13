import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  categoryIdFor,
  isCategoryId,
  MAX_CATEGORIES,
  MAX_CATEGORY_DESCRIPTION,
  MAX_CATEGORY_NAME,
  NEW_CATEGORY_COLORS,
  OTHER,
  sortCategories,
  type CategoryInfo,
} from '../../shared/categories.js';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/client.js';
import { captures, categories, type CategoryRow } from '../db/schema.js';
import { sendError } from '../http.js';

export function toCategoryInfo(row: CategoryRow): CategoryInfo {
  return { id: row.id, name: row.name, description: row.description, color: row.color, position: row.position };
}

/** The owner's categories, Other last. */
export async function listCategories(db: Db, ownerId: string): Promise<CategoryInfo[]> {
  const rows = await db.select().from(categories).where(eq(categories.ownerId, ownerId)).orderBy(asc(categories.position));
  return sortCategories(rows.map(toCategoryInfo));
}

export async function categoryExists(db: Db, ownerId: string, id: string): Promise<boolean> {
  if (!isCategoryId(id)) return false;
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.ownerId, ownerId), eq(categories.id, id)));
  return Boolean(row);
}

const nameField = z.string().trim().min(1).max(MAX_CATEGORY_NAME);
const descriptionField = z.string().trim().max(MAX_CATEGORY_DESCRIPTION);
const createSchema = z.object({ name: nameField, description: descriptionField.default('') }).strict();
const patchSchema = z
  .object({ name: nameField.optional(), description: descriptionField.optional() })
  .strict()
  .refine((p) => p.name !== undefined || p.description !== undefined, { message: 'Nothing to update' });
const idParams = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/) });

function isNameTaken(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint ?? e?.cause?.constraint;
  return code === '23505' && (constraint === undefined || constraint === 'categories_owner_name_idx');
}

const NAME_TAKEN = 'A category with this name already exists.';

export async function createCategory(
  db: Db,
  ownerId: string,
  input: { name: string; description: string },
): Promise<{ ok: true; category: CategoryInfo } | { ok: false; status: number; message: string }> {
  const existing = await db.select().from(categories).where(eq(categories.ownerId, ownerId));
  if (existing.length >= MAX_CATEGORIES) return { ok: false, status: 400, message: `At most ${MAX_CATEGORIES} categories.` };
  if (existing.some((c) => c.name.toLowerCase() === input.name.toLowerCase())) return { ok: false, status: 409, message: NAME_TAKEN };
  const used = new Set(existing.map((c) => c.color));
  const color = NEW_CATEGORY_COLORS.find((c) => !used.has(c)) ?? NEW_CATEGORY_COLORS[existing.length % NEW_CATEGORY_COLORS.length]!;
  const position = Math.max(-1, ...existing.filter((c) => c.id !== OTHER).map((c) => c.position)) + 1;
  try {
    const [row] = await db
      .insert(categories)
      .values({ ownerId, id: categoryIdFor(input.name, existing.map((c) => c.id)), name: input.name, description: input.description, color, position })
      .returning();
    return { ok: true, category: toCategoryInfo(row!) };
  } catch (err) {
    if (isNameTaken(err)) return { ok: false, status: 409, message: NAME_TAKEN };
    throw err;
  }
}

/**
 * Deleting a category archives its captures and moves them to Other, in one transaction:
 * they stay readable in the archive, and reopening one brings it back under Other. Nothing is
 * deleted. Other itself cannot be deleted.
 */
export async function deleteCategory(db: Db, ownerId: string, id: string): Promise<{ archived: number } | null> {
  if (id === OTHER) return null;
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.ownerId, ownerId), eq(categories.id, id)))
      .for('update');
    if (!target) return null;
    const now = new Date();
    const moved = await tx
      .update(captures)
      .set({
        category: OTHER,
        status: 'archived',
        archivedAt: sql`case when ${captures.status} = 'archived' then ${captures.archivedAt} else ${now.toISOString()}::timestamptz end`,
        doneAt: null,
        updatedAt: now,
      })
      .where(and(eq(captures.ownerId, ownerId), eq(captures.category, id)))
      .returning({ id: captures.id, status: captures.status });
    await tx.delete(categories).where(and(eq(categories.ownerId, ownerId), eq(categories.id, id)));
    return { archived: moved.length };
  });
}

export function registerCategoryRoutes(app: FastifyInstance, { db }: AppDeps): void {
  app.get('/api/categories', async (req) => ({ categories: await listCategories(db, req.user!.id) }));

  app.post('/api/categories', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_input', 'Give the category a name (40 characters at most).');
    const result = await createCategory(db, req.user!.id, parsed.data);
    if (!result.ok) return sendError(reply, result.status, 'invalid_input', result.message);
    return reply.code(201).send({ category: result.category });
  });

  app.patch('/api/categories/:id', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Category not found.');
    if (params.data.id === OTHER) return sendError(reply, 400, 'invalid_input', 'Other cannot be changed.');
    const patch = patchSchema.safeParse(req.body);
    if (!patch.success) return sendError(reply, 400, 'invalid_input', 'Give the category a name (40 characters at most).');
    try {
      const [row] = await db
        .update(categories)
        .set({ ...patch.data, updatedAt: new Date() })
        .where(and(eq(categories.ownerId, req.user!.id), eq(categories.id, params.data.id), ne(categories.id, OTHER)))
        .returning();
      if (!row) return sendError(reply, 404, 'not_found', 'Category not found.');
      return { category: toCategoryInfo(row) };
    } catch (err) {
      if (isNameTaken(err)) return sendError(reply, 409, 'invalid_input', NAME_TAKEN);
      throw err;
    }
  });

  app.delete('/api/categories/:id', async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Category not found.');
    if (params.data.id === OTHER) return sendError(reply, 400, 'invalid_input', 'Other cannot be deleted.');
    const result = await deleteCategory(db, req.user!.id, params.data.id);
    if (!result) return sendError(reply, 404, 'not_found', 'Category not found.');
    return result;
  });
}
