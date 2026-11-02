import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

export const SESSION_COOKIE = 'bc_session';
// The phone should stay signed in: a capture tool that asks for a password is not used.
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: digest(token), userId, expiresAt });
  return { token, expiresAt };
}

export interface SessionUser {
  id: string;
  email: string;
  /** Set when the expiry was pushed forward and the cookie should be re-issued. */
  renewedExpiresAt: Date | null;
}

export async function resolveSession(db: Db, token: string): Promise<SessionUser | null> {
  const now = new Date();
  const [row] = await db
    .select({ sessionId: sessions.id, lastSeenAt: sessions.lastSeenAt, userId: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, digest(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;

  let renewedExpiresAt: Date | null = null;
  if (now.getTime() - row.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    renewedExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: renewedExpiresAt })
      .where(eq(sessions.id, row.sessionId));
  }
  return { id: row.userId, email: row.email, renewedExpiresAt };
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, digest(token)));
}
