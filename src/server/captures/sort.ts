import type { FastifyBaseLogger } from 'fastify';
import { isValidTimeZone } from '../../shared/event.js';
import { looksLikeCalendarRequest } from '../ai/event-prompt.js';
import type { Ai } from '../ai/types.js';
import type { Db } from '../db/client.js';
import type { CaptureRow, NutritionEntryRow } from '../db/schema.js';
import type { FoodLookup } from '../nutrition/foods.js';
import { buildEntry, getEntry, moveCaptureToNutrition, type When } from '../nutrition/service.js';
import { askCategory, beginClassification, failClassification, finishClassification, getCapture } from './service.js';

// What happens to a capture once it is safely stored: the model says what it is. A note gets
// its category and title, as before. A meal, a workout or a weigh-in is read in full and leaves
// the notes for the Nutrition section, in one transaction: from then on it shows in no
// category, history, Today or counter. Any failure on the way leaves the capture where it is,
// saved, and the retry sweep comes back to it.

export interface SortDeps {
  db: Db;
  ai: Ai;
  /** Null: this caller never routes to Nutrition. */
  foods: FoodLookup | null;
}

export type Sorted = { kind: 'capture'; row: CaptureRow } | { kind: 'nutrition'; row: NutritionEntryRow };

const FALLBACK_TIME_ZONE = 'Europe/Paris';

/** When a capture was made, as its phone saw it; the server's clock for rows older than that. */
export function whenOf(capture: CaptureRow): When {
  return {
    reference: capture.capturedAt ?? capture.createdAt,
    timeZone: capture.timeZone && isValidTimeZone(capture.timeZone) ? capture.timeZone : FALLBACK_TIME_ZONE,
  };
}

/**
 * A link is always a note. A calendar request too: "mets dans mon agenda déjeuner avec Sarah"
 * is an event, whatever it says about lunch. And what Julien marked as a note stays one.
 */
export function mayBeNutrition(capture: CaptureRow): boolean {
  return !capture.keptAsNote && capture.kind !== 'link' && !looksLikeCalendarRequest(capture.originalText);
}

/**
 * Where a capture is now. Two attempts can overlap (an upload still being read when the retry
 * sweep picks the same capture up): the one that arrives second must answer with what the first
 * one made of it, the Nutrition entry included, never with a note that no longer exists.
 */
async function whereItIs(db: Db, row: CaptureRow): Promise<Sorted> {
  const capture = await getCapture(db, row.ownerId, row.id);
  if (capture) return { kind: 'capture', row: capture };
  const entry = await getEntry(db, row.ownerId, row.id);
  // Neither: deleted meanwhile. The caller gets the row it had, as before.
  return entry ? { kind: 'nutrition', row: entry } : { kind: 'capture', row };
}

export async function sortCapture(
  { db, ai, foods }: SortDeps,
  row: CaptureRow,
  options: {
    /** False for an app version that does not know Nutrition yet: it gets its note back. */
    nutrition: boolean;
    log?: FastifyBaseLogger;
  },
): Promise<Sorted> {
  // No key configured yet: leave it pending so it is sorted once a key is added.
  if (!ai.available) return { kind: 'capture', row };
  const attempt = await beginClassification(db, row);
  // Already sorted, or no longer among the notes.
  if (!attempt) return whereItIs(db, row);

  try {
    const result = await askCategory(db, ai, attempt);
    if (foods && options.nutrition && result.intent && result.intent !== 'note' && mayBeNutrition(attempt)) {
      const when = whenOf(attempt);
      // The full reading has the last word: it may still say this is not for Nutrition. If it
      // cannot be asked, the whole attempt fails and is retried, rather than filing a meal
      // under a category for good.
      // The text as it reads now: the same one the first reading was given.
      const extraction = await ai.extractNutrition({ text: attempt.text, ...when });
      const built = await buildEntry(db, foods, attempt.ownerId, extraction, when);
      if (built) {
        const entry = await moveCaptureToNutrition(db, attempt, built, when);
        if (entry) return { kind: 'nutrition', row: entry };
        // Not moved: another attempt moved it first, or it was deleted or marked as a note
        // while the model was answering.
        const now = await whereItIs(db, attempt);
        if (now.kind === 'nutrition') return now;
      }
    }
    return { kind: 'capture', row: await finishClassification(db, attempt, result) };
  } catch (err) {
    options.log?.warn({ err: (err as Error).message, captureId: attempt.id }, 'capture sorting failed');
    return { kind: 'capture', row: await failClassification(db, attempt) };
  }
}
