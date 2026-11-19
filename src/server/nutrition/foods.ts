import type { FoodSource, Macros } from '../../shared/nutrition.js';
import { CIQUAL, type CiqualRow } from './ciqual-data.js';

// Where the numbers of a food come from, in this order:
//   1. Open Food Facts, only when a brand or product name was said ("un Activia", "un Snickers");
//   2. the Ciqual table (Anses), bundled with the app, for everything generic;
//   3. the model's own estimate, when neither has a believable match. The entry then says so.
// The model always gives its estimate per 100 g: it is the fallback, and also the sanity check
// that keeps a look-alike name from winning ("pomme" must not become "pomme de terre frite").

export interface FoodQuery {
  /** As said, for display and for the product search. */
  name: string;
  /** Generic French name, as a composition table would write it ("riz blanc cuit"). */
  nameFr: string;
  brand: string | null;
  /** The model's estimate per 100 g. */
  estimate: Macros;
}

export interface FoodMatch {
  per100: Macros;
  source: Extract<FoodSource, 'ciqual' | 'off' | 'estimate'>;
  ref: string | null;
}

export interface FoodLookup {
  resolve(query: FoodQuery): Promise<FoodMatch>;
}

// ---------------------------------------------------------------------------------------
// Ciqual: lexical match on the French name.
// ---------------------------------------------------------------------------------------

const STOPWORDS = new Set(['de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'a', 'au', 'aux', 'en', 'et', 'ou', 'sans', 'avec', 'sur', 'pour', 'un', 'une', 'type', 'non', 'ni']);

// Qualifiers the table adds and nobody says: missing from what was dictated, they cost nothing.
const NEUTRAL = new Set([
  'cru', 'cuit', 'chair', 'peau', 'noyau', 'pepin', 'pulp', 'sel', 'ajoutE', 'sucr', 'precision', 'aliment', 'moyen',
  'natur', 'standard', 'preemballE', 'frai', 'entier', 'egouttE', 'pret', 'boir', 'instantanE', 'bouilli', 'eau', 'pasteurisE',
  'uht', 'rayon', 'ordinair', 'courant', 'tout', 'viand', 'legum', 'fruit', 'alcool', 'doux', 'min', 'mg', 'minimum',
]);
const COOKED = new Set(['cuit', 'bouilli', 'roti', 'grillE', 'poelE', 'sautE', 'frit', 'vapeur', 'braisE', 'four', 'rissolE', 'mijotE', 'dur', 'brouillE', 'plat', 'cuisson', 'cuisinE']);
const RAW = new Set(['cru']);

/**
 * Lowercase, accents dropped, plural and feminine endings cut ("crues" → "cru"), a final "é"
 * kept apart as "E" so "pâté" and "pâtes" stay two different words.
 */
export function foodTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(/œ/g, 'oe').split(/[^a-zà-ÿ0-9%]+/)) {
    if (!raw) continue;
    let word = raw;
    let marked = false;
    const accented = word.match(/^(.*?)(ée?s?|és)$/);
    if (accented && accented[1]!.length >= 2) {
      word = accented[1]!;
      marked = true;
    }
    word = word.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!marked && word.length > 3) word = word.replace(/(es|s|x|e)$/, '');
    if (STOPWORDS.has(word) || (!marked && STOPWORDS.has(raw.normalize('NFD').replace(/[̀-ͯ]/g, '')))) continue;
    out.push(marked ? `${word}E` : word);
  }
  return out;
}

interface IndexedFood {
  row: CiqualRow;
  tokens: Set<string>;
  head: string[];
  /** Alternatives spelled out in the name ("Yaourt ou lait fermenté"): never held against it. */
  alternatives: Set<string>;
  cooked: boolean;
  raw: boolean;
  average: boolean;
}

let index: IndexedFood[] | null = null;
function ciqualIndex(): IndexedFood[] {
  index ??= CIQUAL.map((row) => {
    const name = row[1];
    const tokens = foodTokens(name);
    const [first = name, ...others] = (name.split(/[,(]/)[0] ?? name).split(/\s+ou\s+/);
    const head = foodTokens(first);
    return {
      row,
      tokens: new Set(tokens),
      head: head.length ? head : tokens.slice(0, 1),
      alternatives: new Set(others.flatMap(foodTokens)),
      cooked: tokens.some((t) => COOKED.has(t)),
      raw: tokens.some((t) => RAW.has(t)),
      average: /aliment moyen/i.test(name),
    };
  });
  return index;
}

const MIN_SCORE = 2.4;
const MIN_COVERAGE = 0.6;
/** Beyond this gap with the model's own estimate, a match is a look-alike, not the food. */
const MAX_KCAL_GAP = 0.45;

function kcalGap(a: number, b: number): number {
  // Small numbers (vegetables, drinks): 20 against 35 kcal is the same food.
  if (Math.abs(a - b) <= 25) return 0;
  return Math.abs(a - b) / Math.max(a, b);
}

export interface CiqualMatch {
  row: CiqualRow;
  score: number;
}

// Everyday words the table files under another name: every pasta shape is "Pâtes" there.
const ALIASES: Record<string, string> = Object.fromEntries(
  ['spaghetti', 'tagliatell', 'penn', 'fusilli', 'coquillett', 'macaroni', 'linguin', 'farfall', 'rigatoni', 'torsad', 'nouill'].map((shape) => [shape, 'pat']),
);

/** Best Ciqual row for a French food name, or null when nothing is close enough. */
export function matchCiqual(nameFr: string, estimateKcal?: number): CiqualMatch | null {
  const query = [...new Set(foodTokens(nameFr).map((t) => ALIASES[t] ?? t))];
  if (query.length === 0) return null;
  const q = new Set(query);
  const wantsCooked = query.some((t) => COOKED.has(t));
  const wantsRaw = query.some((t) => RAW.has(t));
  const specific = query.filter((t) => !COOKED.has(t) && !NEUTRAL.has(t)).length;

  let best: CiqualMatch | null = null;
  for (const food of ciqualIndex()) {
    const covered = query.filter((t) => food.tokens.has(t) || (COOKED.has(t) && food.cooked)).length / query.length;
    // The table's main word must be among the words said ("pomme" → "Pomme, ..."), unless
    // several words were said and all are in the name ("steak haché" → "Boeuf, steak haché
    // 15% MG, cuit"). One word alone is not enough: "kebab" is not "Pizza kebab".
    // Half of what was said must be found, and more: "barre maison" is not a chocolate bar.
    if (covered < MIN_COVERAGE) continue;
    const headSaid = q.has(food.head[0]!);
    if (!headSaid && !(specific >= 2 && query.every((t) => food.tokens.has(t)))) continue;
    const restOfHead = food.head.slice(1);
    const headScore = headSaid ? 0.7 + 0.3 * (restOfHead.length ? restOfHead.filter((t) => q.has(t)).length / restOfHead.length : 1) : 0.6;
    let extraNeutral = 0;
    let extra = 0;
    for (const t of food.tokens) {
      if (q.has(t)) continue;
      if (NEUTRAL.has(t) || COOKED.has(t) || food.alternatives.has(t)) extraNeutral += 1;
      else extra += 1;
    }
    let score = 2 * headScore + 1.5 * covered - 0.12 * extra - 0.02 * extraNeutral + (food.average ? 0.15 : 0);
    if (wantsCooked && food.cooked) score += 0.1;
    if ((wantsCooked && food.raw && !food.cooked) || (wantsRaw && food.cooked && !food.raw)) score -= 0.6;
    // What was said first is the food itself ("glace vanille" is not vanilla extract).
    if (!food.tokens.has(query[0]!)) score -= 0.5;
    if (estimateKcal !== undefined) {
      const gap = kcalGap(food.row[2], estimateKcal);
      if (gap > MAX_KCAL_GAP) continue;
      // Among look-alikes, the one nearest to the estimate; far from it, a real handicap.
      score -= 0.3 * gap + 0.8 * Math.max(0, gap - 0.2);
    }
    if (score >= MIN_SCORE && (!best || score > best.score)) best = { row: food.row, score };
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// Open Food Facts: products. Free, no key; its search answers slowly or not at all at times,
// so it gets a short timeout and is never needed for an answer.
// ---------------------------------------------------------------------------------------

const OFF_SEARCH = 'https://world.openfoodfacts.org/cgi/search.pl';
const OFF_TIMEOUT_MS = 4000;
const OFF_CACHE_MAX = 200;

interface OffProduct {
  product_name?: unknown;
  brands?: unknown;
  nutriments?: Record<string, unknown>;
}

function offMacros(p: OffProduct): Macros | null {
  const n = p.nutriments ?? {};
  const kcal = n['energy-kcal_100g'];
  const values = [kcal, n.proteins_100g, n.carbohydrates_100g, n.fat_100g];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) return null;
  const [k, protein, carbs, fat] = values as number[];
  if (k! > 950) return null;
  return { kcal: Math.round(k!), protein: Math.round(protein! * 10) / 10, carbs: Math.round(carbs! * 10) / 10, fat: Math.round(fat! * 10) / 10 };
}

async function searchOff(fetchImpl: typeof fetch, query: FoodQuery): Promise<FoodMatch | null> {
  const brandTokens = foodTokens(query.brand ?? '');
  if (brandTokens.length === 0) return null;
  const params = new URLSearchParams({
    search_terms: `${query.brand} ${query.name}`.slice(0, 120),
    search_simple: '1',
    action: 'process',
    json: '1',
    page_size: '8',
    fields: 'product_name,brands,nutriments',
  });
  const res = await fetchImpl(`${OFF_SEARCH}?${params}`, {
    headers: { 'User-Agent': 'BrainCapture/1.0 (personal nutrition log)' },
    signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { products?: OffProduct[] };
  // Several products carry the brand (plain, sweetened, a dessert...): the one nearest to the
  // model's estimate is the likeliest to be what was meant.
  let best: { match: FoodMatch; gap: number } | null = null;
  for (const product of body.products ?? []) {
    const per100 = offMacros(product);
    if (!per100) continue;
    const label = `${typeof product.product_name === 'string' ? product.product_name : ''} ${typeof product.brands === 'string' ? product.brands : ''}`;
    const words = new Set(foodTokens(label));
    // The brand that was said must be on the product, and the product must be in the same
    // league as the model's estimate (a "Coca-Cola" search also returns sweets and sauces).
    if (!brandTokens.some((t) => words.has(t))) continue;
    const gap = kcalGap(per100.kcal, query.estimate.kcal);
    if (gap > MAX_KCAL_GAP || (best && best.gap <= gap)) continue;
    const name = typeof product.product_name === 'string' ? product.product_name.trim() : '';
    const brands = typeof product.brands === 'string' ? product.brands.split(',')[0]!.trim() : '';
    best = { gap, match: { per100, source: 'off', ref: [name, brands].filter(Boolean).join(' · ').slice(0, 200) || null } };
  }
  return best?.match ?? null;
}

/** `fetchImpl: null` turns the product search off (tests, or no outbound network). */
export function createFoodLookup(options: { fetchImpl?: typeof fetch | null } = {}): FoodLookup {
  const fetchImpl = options.fetchImpl === undefined ? fetch : options.fetchImpl;
  const cache = new Map<string, FoodMatch | null>();
  return {
    async resolve(query) {
      if (query.brand && fetchImpl) {
        const key = `${query.brand}|${query.name}`.toLowerCase();
        let product = cache.get(key);
        if (product === undefined) {
          try {
            product = await searchOff(fetchImpl, query);
            if (cache.size >= OFF_CACHE_MAX) cache.delete(cache.keys().next().value!);
            cache.set(key, product);
          } catch {
            // Unreachable or slow: not remembered, so the next capture asks again.
            product = null;
          }
        }
        if (product) return product;
      }
      const match = matchCiqual(query.nameFr || query.name, query.estimate.kcal);
      if (match) {
        const [, name, kcal, protein, carbs, fat] = match.row;
        return { per100: { kcal, protein, carbs, fat }, source: 'ciqual', ref: name };
      }
      return { per100: query.estimate, source: 'estimate', ref: null };
    },
  };
}
