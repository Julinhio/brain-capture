/**
 * Sends real photos to the vision model, as the phone would (resized to 1280 px), and prints
 * the entry the card would show: foods, quantities, calories and where the values come from.
 * Usage: npx tsx --env-file=<path to .env with GROQ_API_KEY> scripts/eval-photo.ts <photo> [<photo> "caption"]...
 * An argument that is not an existing file is the caption of the photo before it.
 * Free tier: a photo counts for about 2,000 tokens out of 8,000 a minute, hence the pause (two photos a minute).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createGroqAi } from '../src/server/ai/groq.js';
import { openDb } from '../src/server/db/client.js';
import { users } from '../src/server/db/schema.js';
import { createFoodLookup } from '../src/server/nutrition/foods.js';
import { buildEntry } from '../src/server/nutrition/service.js';
import { sumMacros, type MealData, type WeightData, type WorkoutData } from '../src/shared/nutrition.js';

async function main(): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is missing (pass --env-file)');
  const args = process.argv.slice(2);
  const photos: { file: string; caption: string }[] = [];
  for (const arg of args) {
    if (existsSync(arg)) photos.push({ file: arg, caption: '' });
    else if (photos.length) photos[photos.length - 1]!.caption = arg;
    else throw new Error(`Not a file: ${arg}`);
  }
  if (photos.length === 0) throw new Error('Pass at least one photo');

  const ai = createGroqAi({
    apiKey,
    transcribeModel: 'whisper-large-v3-turbo',
    classifyModel: process.env.GROQ_CLASSIFY_MODEL || 'openai/gpt-oss-20b',
    visionModel: process.env.GROQ_VISION_MODEL || undefined,
  });
  const foods = createFoodLookup();
  const { db, close } = await openDb('pglite:memory');
  const [owner] = await db.insert(users).values({ email: 'eval@example.com', passwordHash: 'x' }).returning();
  const when = { reference: new Date(), timeZone: 'Europe/Paris' };
  try {
    for (const [i, photo] of photos.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, Number(process.env.EVAL_DELAY_MS ?? 35_000)));
      const image = await sharp(readFileSync(photo.file)).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      const t0 = Date.now();
      const extraction = await ai.readPhoto({ image, mimeType: 'image/jpeg', caption: photo.caption, ...when });
      const built = await buildEntry(db, foods, owner!.id, extraction, when);
      console.log(`\n# ${path.basename(photo.file)}${photo.caption ? ` + "${photo.caption}"` : ' (no caption)'}  [${Math.round(image.length / 1024)} KB sent, ${Date.now() - t0} ms]`);
      console.log(`  saw: ${extraction.description}`);
      if (!built) {
        console.log(`  → not for Nutrition: becomes a note${extraction.text ? ` with the text read: ${extraction.text.slice(0, 200)}` : ''}`);
      } else if (built.type === 'meal') {
        const meal = built.data as MealData;
        const total = sumMacros(meal.items);
        console.log(`  → meal "${built.title}" (${meal.slot}): ${total.kcal} kcal, P ${total.protein} g, C ${total.carbs} g, F ${total.fat} g`);
        for (const it of meal.items) console.log(`     - ${it.name}: ${it.grams} g, ${it.kcal} kcal [${it.source}${it.ref ? `: ${it.ref}` : ''}]`);
      } else if (built.type === 'workout') {
        const w = built.data as WorkoutData;
        console.log(`  → workout "${built.title}": ${w.minutes} min, ${w.kcal} kcal`);
      } else {
        console.log(`  → weight: ${(built.data as WeightData).kg} kg`);
      }
    }
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
