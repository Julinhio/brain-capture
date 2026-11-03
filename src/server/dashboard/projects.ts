import { and, count, desc, eq, gte, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROJECT_STATES, type Project } from '../../shared/dashboard.js';
import type { AppDeps } from '../app.js';
import { toCapture } from '../captures/service.js';
import type { Db } from '../db/client.js';
import { captures, projectCaptures, projects } from '../db/schema.js';
import { sendError } from '../http.js';
import { dayWindow } from './day.js';

const fields = z.object({
  name: z.string().trim().min(1).max(120),
  intention: z.string().trim().max(2000),
  state: z.enum(PROJECT_STATES),
  nextStep: z.string().trim().max(500),
});
// Defaults belong only to creation. In Zod 4 an optional field with a default
// still gets filled, which would silently reset omitted fields during PATCH.
const createFields = fields.extend({
  intention: fields.shape.intention.default(''),
  state: fields.shape.state.default('idea'),
  nextStep: fields.shape.nextStep.default(''),
  captureId: z.uuid().optional(),
});
const params = z.object({ id: z.uuid() });
const linkParams = z.object({ id: z.uuid(), captureId: z.uuid() });

export async function listProjects(db: Db, ownerId: string): Promise<Project[]> {
  const rows = await db
    .select({ project: projects, captureCount: count(projectCaptures.captureId) })
    .from(projects)
    .leftJoin(projectCaptures, eq(projects.id, projectCaptures.projectId))
    .where(eq(projects.ownerId, ownerId))
    .groupBy(projects.id)
    .orderBy(desc(projects.updatedAt));
  return rows.map(({ project, captureCount }) => ({
    ...project,
    ownerId: undefined,
    state: project.state as Project['state'],
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    captureCount,
  }));
}

export function registerProjectRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/api/projects', async (req) => ({ projects: await listProjects(db, req.user!.id) }));
  app.post('/api/projects', async (req, reply) => {
    const parsed = createFields.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_input', 'Le projet est incomplet ou trop long.');
    const { captureId, ...input } = parsed.data;
    if (captureId) {
      const [capture] = await db
        .select({ id: captures.id })
        .from(captures)
        .where(and(eq(captures.id, captureId), eq(captures.ownerId, req.user!.id)));
      if (!capture) return sendError(reply, 404, 'not_found', 'Capture introuvable.');
    }
    const row = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(projects)
        .values({ ...input, ownerId: req.user!.id })
        .returning({ id: projects.id });
      if (captureId) await tx.insert(projectCaptures).values({ projectId: row!.id, captureId });
      return row;
    });
    return reply.code(201).send({ id: row!.id });
  });
  app.patch('/api/projects/:id', async (req, reply) => {
    const p = params.safeParse(req.params);
    const body = fields
      .partial()
      .strict()
      .refine((v) => Object.keys(v).length > 0)
      .safeParse(req.body);
    if (!p.success || !body.success) return sendError(reply, 400, 'invalid_input', 'Modification de projet invalide.');
    const [row] = await db
      .update(projects)
      .set({ ...body.data, updatedAt: new Date() })
      .where(and(eq(projects.id, p.data.id), eq(projects.ownerId, req.user!.id)))
      .returning({ id: projects.id });
    if (!row) return sendError(reply, 404, 'not_found', 'Projet introuvable.');
    return row;
  });
  app.get('/api/projects/:id/captures', async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return sendError(reply, 404, 'not_found', 'Projet introuvable.');
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, p.data.id), eq(projects.ownerId, req.user!.id)));
    if (!project) return sendError(reply, 404, 'not_found', 'Projet introuvable.');
    const rows = await db
      .select({ capture: captures })
      .from(projectCaptures)
      .innerJoin(captures, eq(captures.id, projectCaptures.captureId))
      .where(and(eq(projectCaptures.projectId, project.id), eq(captures.ownerId, req.user!.id)))
      .orderBy(desc(captures.createdAt));
    return { captures: rows.map((r) => toCapture(r.capture)) };
  });
  app.get('/api/captures/:id/projects', async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return sendError(reply, 404, 'not_found', 'Capture introuvable.');
    const [capture] = await db
      .select({ id: captures.id })
      .from(captures)
      .where(and(eq(captures.id, p.data.id), eq(captures.ownerId, req.user!.id)));
    if (!capture) return sendError(reply, 404, 'not_found', 'Capture introuvable.');
    const rows = await db
      .select({ id: projects.id })
      .from(projectCaptures)
      .innerJoin(projects, eq(projects.id, projectCaptures.projectId))
      .where(and(eq(projectCaptures.captureId, p.data.id), eq(projects.ownerId, req.user!.id)));
    return { projectIds: rows.map((r) => r.id) };
  });
  app.put('/api/projects/:id/captures/:captureId', async (req, reply) => {
    const p = linkParams.safeParse(req.params);
    if (!p.success) return sendError(reply, 400, 'invalid_input', 'Lien de projet invalide.');
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, p.data.id), eq(projects.ownerId, req.user!.id)));
    const [capture] = await db
      .select({ id: captures.id })
      .from(captures)
      .where(and(eq(captures.id, p.data.captureId), eq(captures.ownerId, req.user!.id)));
    if (!project || !capture) return sendError(reply, 404, 'not_found', 'Projet ou capture introuvable.');
    await db.insert(projectCaptures).values({ projectId: project.id, captureId: capture.id }).onConflictDoNothing();
    return { ok: true };
  });
  app.delete('/api/projects/:id/captures/:captureId', async (req, reply) => {
    const p = linkParams.safeParse(req.params);
    if (!p.success) return sendError(reply, 400, 'invalid_input', 'Lien de projet invalide.');
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, p.data.id), eq(projects.ownerId, req.user!.id)));
    if (!project) return sendError(reply, 404, 'not_found', 'Projet introuvable.');
    await db
      .delete(projectCaptures)
      .where(and(eq(projectCaptures.projectId, project.id), eq(projectCaptures.captureId, p.data.captureId)));
    return { ok: true };
  });
  app.get('/api/today', async (req, reply) => {
    let window;
    try {
      window = dayWindow(
        z
          .string()
          .max(100)
          .parse((req.query as { timeZone?: string }).timeZone ?? 'Europe/Paris'),
      );
    } catch {
      return sendError(reply, 400, 'invalid_input', 'Fuseau horaire invalide.');
    }
    const condition = and(
      eq(captures.ownerId, req.user!.id),
      gte(captures.createdAt, new Date(window.previousStart)),
      lt(captures.createdAt, new Date(window.start)),
    );
    const [rows, totals, projectRows] = await Promise.all([
      db.select().from(captures).where(condition).orderBy(desc(captures.createdAt)).limit(36),
      db.select({ n: count() }).from(captures).where(condition),
      listProjects(db, req.user!.id),
    ]);
    reply.header('Cache-Control', 'no-store');
    return { window, yesterday: { count: totals[0]!.n, captures: rows.map(toCapture) }, projects: projectRows };
  });
}
