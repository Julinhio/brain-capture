import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

/**
 * There is no sign-up. The single account comes from OWNER_EMAIL / OWNER_PASSWORD_HASH
 * (Railway variables) and is created or updated at boot, so changing the password is a
 * variable change plus a redeploy.
 */
export async function ensureOwner(db: Db, email: string, passwordHash: string): Promise<void> {
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!existing) {
    await db.insert(users).values({ email, passwordHash });
    return;
  }
  if (existing.passwordHash !== passwordHash) {
    // A new password signs every device out, which is the point of changing it.
    await db.update(users).set({ passwordHash }).where(eq(users.id, existing.id));
    await db.delete(sessions).where(eq(sessions.userId, existing.id));
  }
}
