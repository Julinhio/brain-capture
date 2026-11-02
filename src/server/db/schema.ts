import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { CATEGORIES } from '../../shared/categories.js';

export const categoryEnum = pgEnum('category', CATEGORIES);
export const captureKindEnum = pgEnum('capture_kind', ['voice', 'text', 'link']);
export const captureStatusEnum = pgEnum('capture_status', ['open', 'done', 'archived']);
export const categorySourceEnum = pgEnum('category_source', ['auto', 'manual', 'fallback']);
export const classificationStatusEnum = pgEnum('classification_status', ['pending', 'done', 'failed']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    // sha256 of the cookie token: a database leak does not hand out live sessions.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const captures = pgTable(
  'captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Generated on the device before the first upload attempt; retries reuse it, so a
    // capture sent twice is stored once.
    clientId: uuid('client_id').notNull(),
    kind: captureKindEnum('kind').notNull(),
    title: text('title'),
    // Once Julien renames a capture, a late or retried classification must not overwrite it.
    titleManual: boolean('title_manual').notNull().default(false),
    text: text('text').notNull(),
    originalText: text('original_text').notNull(),
    url: text('url'),
    category: categoryEnum('category').notNull().default('other'),
    categorySource: categorySourceEnum('category_source').notNull().default('fallback'),
    classificationStatus: classificationStatusEnum('classification_status').notNull().default('pending'),
    classificationAttempts: integer('classification_attempts').notNull().default(0),
    status: captureStatusEnum('status').notNull().default('open'),
    durationMs: integer('duration_ms'),
    device: text('device'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('captures_owner_client_idx').on(t.ownerId, t.clientId),
    index('captures_owner_status_created_idx').on(t.ownerId, t.status, t.createdAt),
    index('captures_classification_idx')
      .on(t.classificationStatus)
      .where(sql`${t.classificationStatus} <> 'done'`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type CaptureRow = typeof captures.$inferSelect;
