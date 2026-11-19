import type { FastifyBaseLogger } from 'fastify';
import type { Ai } from '../ai/types.js';
import type { Db } from '../db/client.js';
import type { FoodLookup } from '../nutrition/foods.js';
import { pendingClassifications } from './service.js';
import { sortCapture } from './sort.js';

/**
 * Retries classifications that failed or never ran (Groq down, server restarted mid-request).
 * With `foods`, a capture the model now recognises as a meal, a workout or a weigh-in leaves
 * the notes for Nutrition, exactly as it would have at capture time.
 */
export async function sweepClassifications(db: Db, ai: Ai, now = new Date(), foods?: FoodLookup, log?: FastifyBaseLogger): Promise<number> {
  if (!ai.available) return 0;
  const rows = await pendingClassifications(db, new Date(now.getTime() - 30_000), 10);
  let done = 0;
  for (const row of rows) {
    const sorted = await sortCapture({ db, ai, foods: foods ?? null }, row, { nutrition: Boolean(foods), log });
    if (sorted.kind === 'nutrition' || sorted.row.classificationStatus === 'done') done += 1;
  }
  return done;
}

export function startClassificationSweeper(db: Db, ai: Ai, log: FastifyBaseLogger, foods?: FoodLookup, intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepClassifications(db, ai, new Date(), foods, log)
      .catch((err: unknown) => log.warn({ err }, 'classification sweep failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
