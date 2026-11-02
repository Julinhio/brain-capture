import type { FastifyBaseLogger } from 'fastify';
import type { Ai } from '../ai/types.js';
import type { Db } from '../db/client.js';
import { classifyCapture, pendingClassifications } from './service.js';

/** Retries classifications that failed or never ran (Groq down, server restarted mid-request). */
export async function sweepClassifications(db: Db, ai: Ai, now = new Date()): Promise<number> {
  if (!ai.available) return 0;
  const rows = await pendingClassifications(db, new Date(now.getTime() - 30_000), 10);
  let done = 0;
  for (const row of rows) {
    const updated = await classifyCapture(db, ai, row);
    if (updated.classificationStatus === 'done') done += 1;
  }
  return done;
}

export function startClassificationSweeper(db: Db, ai: Ai, log: FastifyBaseLogger, intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepClassifications(db, ai)
      .catch((err: unknown) => log.warn({ err }, 'classification sweep failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
