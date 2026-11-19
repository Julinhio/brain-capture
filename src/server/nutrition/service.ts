import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  DEFAULT_KCAL_GOAL,
  DEFAULT_WEIGHT_KG,
  MAX_TITLE,
  MAX_WEIGHT_KG,
  MIN_WEIGHT_KG,
  dayTotals,
  defaultTitle,
  localDay,
  localHour,
  portion,
  round1,
  shiftDay,
  slotForHour,
  sumMacros,
  workoutKcal,
  type FoodItem,
  type HistoryDay,
  type MealData,
  type NutritionData,
  type NutritionDay,
  type NutritionEntry,
  type NutritionHistory,
  type NutritionSettings,
  type NutritionSource,
  type NutritionStatus,
  type NutritionType,
  type WeightData,
  type WorkoutData,
} from '../../shared/nutrition.js';
import { fallbackTitle } from '../../shared/text.js';
import type { NutritionExtraction } from '../ai/types.js';
import { findByClientId, findDeletedByClientId, lockClientId } from '../captures/service.js';
import type { Db } from '../db/client.js';
import {
  captures,
  deletedCaptures,
  nutritionEntries,
  nutritionPhotos,
  nutritionSettings,
  type CaptureRow,
  type NutritionEntryRow,
} from '../db/schema.js';
import type { FoodLookup } from './foods.js';

export function toEntry(row: NutritionEntryRow): NutritionEntry {
  return {
    id: row.id,
    clientId: row.clientId,
    type: row.type,
    status: row.status,
    source: row.source,
    day: row.day,
    occurredAt: row.occurredAt.toISOString(),
    title: row.title,
    originalText: row.originalText,
    hasPhoto: row.hasPhoto,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as NutritionEntry;
}

// ---------------------------------------------------------------------------------------
// From the model's answer to an entry: food values looked up, calories computed.
// ---------------------------------------------------------------------------------------

export interface When {
  /** The phone's clock when the capture was made. */
  reference: Date;
  timeZone: string;
}

export interface BuiltEntry {
  type: NutritionType;
  title: string;
  day: string;
  data: NutritionData;
}

/** The body weight a workout estimate uses: the latest confirmed weigh-in up to that day. */
export async function latestWeight(db: Db, ownerId: string, onOrBefore?: string): Promise<{ kg: number; day: string } | null> {
  const [row] = await db
    .select({ day: nutritionEntries.day, data: nutritionEntries.data })
    .from(nutritionEntries)
    .where(
      and(
        eq(nutritionEntries.ownerId, ownerId),
        eq(nutritionEntries.type, 'weight'),
        eq(nutritionEntries.status, 'confirmed'),
        onOrBefore ? lte(nutritionEntries.day, onOrBefore) : undefined,
      ),
    )
    .orderBy(desc(nutritionEntries.day), desc(nutritionEntries.occurredAt))
    .limit(1);
  return row ? { kg: (row.data as WeightData).kg, day: row.day } : null;
}

/** Null when the model saw nothing to log (`none`, or a type without its essentials). */
export async function buildEntry(db: Db, foods: FoodLookup, ownerId: string, x: NutritionExtraction, when: When): Promise<BuiltEntry | null> {
  const day = shiftDay(localDay(when.reference, when.timeZone), x.dayOffset);
  if (x.type === 'weight') {
    if (x.kg === null || x.kg < MIN_WEIGHT_KG || x.kg > MAX_WEIGHT_KG) return null;
    const data: WeightData = { kg: round1(x.kg) };
    return { type: 'weight', title: defaultTitle('weight', data), day, data };
  }
  if (x.type === 'workout') {
    if (!x.activity) return null;
    // No duration said: half an hour, shown on the card where it is one tap to correct.
    const minutes = x.minutes ?? 30;
    const met = x.met ?? 5;
    const weightKg = (await latestWeight(db, ownerId, day))?.kg ?? DEFAULT_WEIGHT_KG;
    const data: WorkoutData = { activity: x.activity, minutes, met: round1(met), kcal: x.kcal ?? workoutKcal(met, weightKg, minutes), weightKg };
    return { type: 'workout', title: (x.title || `${x.activity} ${minutes} min`).slice(0, MAX_TITLE), day, data };
  }
  if (x.type === 'meal') {
    if (x.items.length === 0) return null;
    const items: FoodItem[] = await Promise.all(
      x.items.map(async (f) => {
        const estimate = { kcal: f.kcal100, protein: f.protein100, carbs: f.carbs100, fat: f.fat100 };
        const match = await foods.resolve({ name: f.name, nameFr: f.nameFr, brand: f.brand, estimate });
        return { name: f.name, grams: f.grams, ...portion(match.per100, f.grams), per100: match.per100, source: match.source, ref: match.ref };
      }),
    );
    // Said for another day ("hier soir") without naming the meal: the time now says nothing.
    const slot = x.slot ?? (x.dayOffset === 0 ? slotForHour(localHour(when.reference, when.timeZone)) : 'snack');
    const data: MealData = { slot, items };
    return { type: 'meal', title: (x.title || defaultTitle('meal', data)).slice(0, MAX_TITLE), day, data };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Storage. A device id (clientId) lives in exactly one place: captures, nutrition_entries or
// the tombstones. Every write below takes the same lock as captures do.
// ---------------------------------------------------------------------------------------

export interface NewEntry extends BuiltEntry {
  clientId: string;
  status: NutritionStatus;
  source: NutritionSource;
  originalText: string;
  when: When;
  durationMs?: number | null;
  device?: string | null;
  photo?: { mimeType: string; bytes: Buffer } | null;
}

export type StoreResult =
  | { kind: 'entry'; row: NutritionEntryRow; created: boolean }
  | { kind: 'capture'; row: CaptureRow }
  | { kind: 'deleted' };

export async function findEntryByClientId(db: Db, ownerId: string, clientId: string): Promise<NutritionEntryRow | null> {
  const [row] = await db
    .select()
    .from(nutritionEntries)
    .where(and(eq(nutritionEntries.ownerId, ownerId), eq(nutritionEntries.clientId, clientId)))
    .limit(1);
  return row ?? null;
}

export async function getEntry(db: Db, ownerId: string, id: string): Promise<NutritionEntryRow | null> {
  const [row] = await db
    .select()
    .from(nutritionEntries)
    .where(and(eq(nutritionEntries.ownerId, ownerId), eq(nutritionEntries.id, id)))
    .limit(1);
  return row ?? null;
}

function entryValues(ownerId: string, e: NewEntry) {
  return {
    ownerId,
    clientId: e.clientId,
    type: e.type,
    status: e.status,
    source: e.source,
    day: e.day,
    occurredAt: e.when.reference,
    timeZone: e.when.timeZone,
    title: e.title,
    originalText: e.originalText,
    data: e.data,
    hasPhoto: Boolean(e.photo),
    durationMs: e.durationMs ?? null,
    device: e.device ?? null,
  };
}

/**
 * Stores an entry once per (owner, clientId). A retry of an upload that already went through
 * gets what was stored; one deleted for good since stays deleted.
 */
export async function storeEntry(db: Db, ownerId: string, entry: NewEntry): Promise<StoreResult> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    await lockClientId(tx, ownerId, entry.clientId);
    if (await findDeletedByClientId(tx, ownerId, entry.clientId)) return { kind: 'deleted' } as const;
    const note = await findByClientId(tx, ownerId, entry.clientId);
    if (note) return { kind: 'capture', row: note } as const;
    const existing = await findEntryByClientId(tx, ownerId, entry.clientId);
    if (existing) return { kind: 'entry', row: existing, created: false } as const;
    const [row] = await tx.insert(nutritionEntries).values(entryValues(ownerId, entry)).returning();
    if (entry.photo) await tx.insert(nutritionPhotos).values({ entryId: row!.id, mimeType: entry.photo.mimeType, bytes: entry.photo.bytes });
    return { kind: 'entry', row: row!, created: true } as const;
  });
}

/**
 * A capture recognised as a meal, a workout or a weigh-in leaves the notes: the row goes, with
 * its project links, and the entry takes its id and its device id. One transaction, so it is
 * never in both places nor in neither. Null when the capture is no longer there to move
 * (deleted meanwhile), or was marked as a note in the meantime.
 */
export async function moveCaptureToNutrition(
  db: Db,
  capture: CaptureRow,
  built: BuiltEntry,
  when: When,
  /** `force`: Julien asked for it himself, so "kept as a note" no longer holds. */
  options: { force?: boolean } = {},
): Promise<NutritionEntryRow | null> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    await lockClientId(tx, capture.ownerId, capture.clientId);
    const [gone] = await tx
      .delete(captures)
      .where(and(eq(captures.id, capture.id), eq(captures.ownerId, capture.ownerId), options.force ? undefined : eq(captures.keptAsNote, false)))
      .returning();
    if (!gone) return null;
    const [row] = await tx
      .insert(nutritionEntries)
      .values({
        ...entryValues(capture.ownerId, {
          ...built,
          clientId: gone.clientId,
          status: 'proposed',
          source: gone.kind === 'voice' ? 'voice' : 'text',
          // What the entry was read from: the note as it reads now, corrections included.
          originalText: gone.text,
          when,
          durationMs: gone.durationMs,
          device: gone.device,
        }),
        id: gone.id,
      })
      .returning();
    return row!;
  });
}

/**
 * "It's a note": the entry leaves Nutrition and becomes the capture it would have been, with the
 * same id and device id, marked so that sorting never sends it back. The photo is not kept.
 */
export async function moveEntryToNote(db: Db, ownerId: string, id: string): Promise<CaptureRow | null> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    const target = await getEntry(tx, ownerId, id);
    if (!target) return null;
    await lockClientId(tx, ownerId, target.clientId);
    const [gone] = await tx
      .delete(nutritionEntries)
      .where(and(eq(nutritionEntries.id, id), eq(nutritionEntries.ownerId, ownerId)))
      .returning();
    if (!gone) return null;
    const text = gone.originalText.trim() || gone.title;
    const [row] = await tx
      .insert(captures)
      .values({
        id: gone.id,
        ownerId,
        clientId: gone.clientId,
        kind: gone.source === 'voice' ? 'voice' : 'text',
        text,
        originalText: text,
        title: fallbackTitle(text, null),
        keptAsNote: true,
        durationMs: gone.durationMs,
        device: gone.device,
        capturedAt: gone.occurredAt,
        timeZone: gone.timeZone,
        createdAt: gone.createdAt,
      })
      .returning();
    return row!;
  });
}

/** Deleted for good, with a tombstone: a phone resending it gets "deleted", not a new entry. */
export async function deleteEntry(db: Db, ownerId: string, id: string): Promise<boolean> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    const target = await getEntry(tx, ownerId, id);
    if (!target) return false;
    await lockClientId(tx, ownerId, target.clientId);
    const [gone] = await tx
      .delete(nutritionEntries)
      .where(and(eq(nutritionEntries.id, id), eq(nutritionEntries.ownerId, ownerId)))
      .returning({ id: nutritionEntries.id, clientId: nutritionEntries.clientId });
    if (!gone) return false;
    await tx.insert(deletedCaptures).values({ captureId: gone.id, ownerId, clientId: gone.clientId, reason: 'deleted' }).onConflictDoNothing();
    return true;
  });
}

export interface EntryPatch {
  status?: NutritionStatus;
  title?: string;
  day?: string;
  data?: NutritionData;
}

export async function updateEntry(db: Db, ownerId: string, id: string, patch: EntryPatch): Promise<NutritionEntryRow | null> {
  const [row] = await db
    .update(nutritionEntries)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(nutritionEntries.id, id), eq(nutritionEntries.ownerId, ownerId)))
    .returning();
  return row ?? null;
}

export async function getPhoto(db: Db, ownerId: string, entryId: string): Promise<{ mimeType: string; bytes: Buffer } | null> {
  const [row] = await db
    .select({ mimeType: nutritionPhotos.mimeType, bytes: nutritionPhotos.bytes })
    .from(nutritionPhotos)
    .innerJoin(nutritionEntries, eq(nutritionEntries.id, nutritionPhotos.entryId))
    .where(and(eq(nutritionPhotos.entryId, entryId), eq(nutritionEntries.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------
// Reading: the day, what waits for a tap, the history behind the charts.
// ---------------------------------------------------------------------------------------

export async function getSettings(db: Db, ownerId: string): Promise<NutritionSettings> {
  const [row] = await db.select().from(nutritionSettings).where(eq(nutritionSettings.ownerId, ownerId));
  return row ? { kcalGoal: row.kcalGoal, goalSet: true } : { kcalGoal: DEFAULT_KCAL_GOAL, goalSet: false };
}

export async function setGoal(db: Db, ownerId: string, kcalGoal: number): Promise<NutritionSettings> {
  await db
    .insert(nutritionSettings)
    .values({ ownerId, kcalGoal })
    .onConflictDoUpdate({ target: nutritionSettings.ownerId, set: { kcalGoal, updatedAt: new Date() } });
  return { kcalGoal, goalSet: true };
}

export async function getDay(db: Db, ownerId: string, day: string): Promise<NutritionDay> {
  const owned = eq(nutritionEntries.ownerId, ownerId);
  const [confirmed, pending, settings, weight] = await Promise.all([
    db
      .select()
      .from(nutritionEntries)
      .where(and(owned, eq(nutritionEntries.day, day), eq(nutritionEntries.status, 'confirmed')))
      .orderBy(asc(nutritionEntries.occurredAt), asc(nutritionEntries.id)),
    db
      .select()
      .from(nutritionEntries)
      .where(and(owned, eq(nutritionEntries.status, 'proposed')))
      .orderBy(desc(nutritionEntries.occurredAt), desc(nutritionEntries.id))
      .limit(50),
    getSettings(db, ownerId),
    latestWeight(db, ownerId, day),
  ]);
  const entries = confirmed.map(toEntry);
  return { day, entries, pending: pending.map(toEntry), totals: dayTotals(entries, settings.kcalGoal), settings, weight };
}

/** One row per day that has something confirmed, oldest first. Small on purpose: a few entries a day. */
export async function getHistory(db: Db, ownerId: string, from: string, to: string): Promise<NutritionHistory> {
  const rows = await db
    .select({ day: nutritionEntries.day, type: nutritionEntries.type, data: nutritionEntries.data })
    .from(nutritionEntries)
    .where(
      and(
        eq(nutritionEntries.ownerId, ownerId),
        eq(nutritionEntries.status, 'confirmed'),
        gte(nutritionEntries.day, from),
        lte(nutritionEntries.day, to),
      ),
    )
    .orderBy(asc(nutritionEntries.day), asc(nutritionEntries.occurredAt), asc(nutritionEntries.id));
  const days = new Map<string, HistoryDay>();
  for (const row of rows) {
    let d = days.get(row.day);
    if (!d) {
      d = { day: row.day, kcal: 0, protein: 0, carbs: 0, fat: 0, burned: 0, weightKg: null, meals: 0, workouts: 0 };
      days.set(row.day, d);
    }
    if (row.type === 'meal') {
      const total = sumMacros([d, ...(row.data as MealData).items]);
      Object.assign(d, total);
      d.meals += 1;
    } else if (row.type === 'workout') {
      d.burned += (row.data as WorkoutData).kcal;
      d.workouts += 1;
    } else {
      // Several weigh-ins the same day: the last one stands for the day.
      d.weightKg = (row.data as WeightData).kg;
    }
  }
  return { from, to, days: [...days.values()], settings: await getSettings(db, ownerId) };
}

/** How many entries wait for a tap: the small badge next to the section's name. */
export async function countPending(db: Db, ownerId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nutritionEntries)
    .where(and(eq(nutritionEntries.ownerId, ownerId), eq(nutritionEntries.status, 'proposed')));
  return row?.n ?? 0;
}
