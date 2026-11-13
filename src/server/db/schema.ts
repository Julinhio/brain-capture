import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { CaptureEventState, EventDraft } from '../../shared/event.js';

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

// Each owner's own list. The id never changes (renaming only touches the name), so a rename
// moves no capture. Seeded with the starting list for every account by migration 0004 (a
// trigger on users covers accounts created later). Other is never deleted.
export const categories = pgTable(
  'categories',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    color: text('color'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.id] }), uniqueIndex('categories_owner_name_idx').on(t.ownerId, sql`lower(${t.name})`)],
);
export type CategoryRow = typeof categories.$inferSelect;

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
    // Always one of the owner's categories (foreign key below): deleting a category first moves
    // its captures to Other, in the same transaction.
    category: text('category').notNull().default('other'),
    categorySource: categorySourceEnum('category_source').notNull().default('fallback'),
    classificationStatus: classificationStatusEnum('classification_status').notNull().default('pending'),
    classificationAttempts: integer('classification_attempts').notNull().default(0),
    status: captureStatusEnum('status').notNull().default('open'),
    durationMs: integer('duration_ms'),
    device: text('device'),
    // Millisecond precision: the pagination cursor round-trips through a JS Date, which
    // would silently drop PostgreSQL's microseconds and skip rows between pages.
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
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
    foreignKey({
      name: 'captures_owner_category_fk',
      columns: [t.ownerId, t.category],
      foreignColumns: [categories.ownerId, categories.id],
    }),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type CaptureRow = typeof captures.$inferSelect;

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  intention: text('intention').notNull().default(''),
  state: text('state').notNull().default('idea'),
  nextStep: text('next_step').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (t) => [index('projects_owner_idx').on(t.ownerId)]);

// A capture can contribute to several projects without changing its category or status.
export const projectCaptures = pgTable('project_captures', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  captureId: uuid('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
}, (t) => [uniqueIndex('project_captures_unique').on(t.projectId, t.captureId)]);

// OAuth refresh tokens are encrypted with a separate server key, never exported.
export const calendarConnections = pgTable('calendar_connections', {
  ownerId: uuid('owner_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  refreshToken: text('refresh_token').notNull(),
  grantedScopes: text('granted_scopes').notNull().default(''),
  // null follows all owned calendars; [] deliberately selects none.
  calendarIds: jsonb('calendar_ids').$type<string[] | null>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// At most one calendar event per capture: the capture id is the primary key here and, on
// Google's side, the event id is derived from it (see captures/event.ts). The capture itself
// is never modified by any of this.
export const captureEvents = pgTable('capture_events', {
  captureId: uuid('capture_id').primaryKey().references(() => captures.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  state: text('state').$type<CaptureEventState>().notNull().default('proposed'),
  extraction: text('extraction').$type<'done' | 'failed'>().notNull(),
  draft: jsonb('draft').$type<EventDraft>().notNull(),
  // The phone's clock and zone when the capture was made: relative dates are read from them,
  // also when the extraction is run again later.
  referenceAt: timestamp('reference_at', { withTimezone: true }).notNull(),
  timeZone: text('time_zone').notNull(),
  calendarId: text('calendar_id'),
  googleEventId: text('google_event_id'),
  eventUrl: text('event_url'),
  lastError: jsonb('last_error').$type<{ code: string; message: string } | null>(),
  createdInCalendarAt: timestamp('created_in_calendar_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('capture_events_owner_idx').on(t.ownerId)]);
export type CaptureEventRow = typeof captureEvents.$inferSelect;

// What is left of a capture deleted for good: enough to keep it from coming back. A phone that
// never got the answer to its upload still holds the capture and sends it again with the same
// clientId; without this row it would be stored anew. A capture turned into a calendar event
// keeps the event here, so a repeated confirmation answers with it instead of calling Google.
export const deletedCaptures = pgTable(
  'deleted_captures',
  {
    captureId: uuid('capture_id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').notNull(),
    reason: text('reason').$type<'deleted' | 'calendar'>().notNull(),
    calendarEvent: jsonb('calendar_event').$type<{
      draft: EventDraft;
      eventUrl: string | null;
      googleEventId: string;
      calendarId: string;
      createdInCalendarAt: string;
    } | null>(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('deleted_captures_owner_client_idx').on(t.ownerId, t.clientId)],
);
export type DeletedCaptureRow = typeof deletedCaptures.$inferSelect;
