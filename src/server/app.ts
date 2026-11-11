import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Ai } from './ai/types.js';
import { burnPasswordCheck, verifyPassword } from './auth/password.js';
import { RateLimiter } from './auth/rate-limit.js';
import { createSession, deleteSession, resolveSession, SESSION_COOKIE } from './auth/sessions.js';
import { registerBackupRoutes } from './backup/backup.js';
import { registerCaptureEventRoutes } from './captures/event.js';
import { registerCaptureRoutes } from './captures/routes.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { users } from './db/schema.js';
import { sendError } from './http.js';
import { registerProjectRoutes } from './dashboard/projects.js';
import { registerRadarRoutes } from './dashboard/radars.js';
import { registerCalendarRoutes } from './dashboard/calendar.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string } | null;
  }
}

export interface AppDeps {
  db: Db;
  ai: Ai;
  config: Config;
  /** Directory with the built web app; served with an SPA fallback when present. */
  webDir?: string;
  logger?: boolean;
}

const PUBLIC_API = new Set(['/api/auth/login', '/api/health']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, config } = deps;
  const app = Fastify({
    trustProxy: config.env === 'production',
    bodyLimit: 1024 * 1024,
    logger: deps.logger
      ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }) } }
      : false,
  });

  await app.register(cookie);
  await app.register(multipart);
  app.decorateRequest('user', null);

  const cookieOptions = (expires: Date) => ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.env === 'production',
    expires,
  });

  // State-changing requests must come from the app itself. SameSite=Lax already keeps the
  // cookie off cross-site POSTs; this closes the remaining same-site and old-browser gaps.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return sendError(reply, 403, 'forbidden_origin', 'Request origin is not allowed.');
    }
    if (originHost !== req.headers.host && !config.allowedOrigins.includes(origin)) {
      return sendError(reply, 403, 'forbidden_origin', 'Request origin is not allowed.');
    }
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const user = await resolveSession(db, token);
      if (user) {
        req.user = { id: user.id, email: user.email };
        if (user.renewedExpiresAt) reply.setCookie(SESSION_COOKIE, token, cookieOptions(user.renewedExpiresAt));
      }
    }
    const routePath = req.url.split('?')[0] ?? '';
    if (!req.user && !PUBLIC_API.has(routePath)) {
      return sendError(reply, 401, 'unauthorized', 'Sign in to continue.');
    }
  });

  // The version lets a deployment be checked from outside without signing in.
  app.get('/api/health', async () => ({ ok: true, version: config.appVersion }));

  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as { email?: unknown; password?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password || password.length > 1024) {
      return sendError(reply, 400, 'invalid_input', 'Email and password are required.');
    }
    if (!loginLimiter.take(req.ip)) {
      return sendError(reply, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
    }
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const valid = user ? await verifyPassword(user.passwordHash, password) : (await burnPasswordCheck(password), false);
    if (!user || !valid) return sendError(reply, 401, 'unauthorized', 'Wrong email or password.');

    loginLimiter.reset(req.ip);
    const session = await createSession(db, user.id);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(session.expiresAt));
    return { id: user.id, email: user.email };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => req.user);

  registerCaptureRoutes(app, deps);
  registerCaptureEventRoutes(app, deps);
  registerBackupRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerRadarRoutes(app, deps);
  registerCalendarRoutes(app, deps);

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err.statusCode && err.statusCode < 500) {
      return sendError(reply, err.statusCode, err.statusCode === 413 ? 'audio_too_large' : 'invalid_input', err.message);
    }
    req.log.error({ err }, 'unhandled error');
    return sendError(reply, 500, 'internal', 'Something went wrong on the server.');
  });

  if (deps.webDir && existsSync(deps.webDir)) {
    await app.register(fastifyStatic, { root: path.resolve(deps.webDir), wildcard: false });
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') {
        return sendError(reply, 404, 'not_found', 'Not found.');
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'not_found', 'Not found.'));
  }

  return app;
}
