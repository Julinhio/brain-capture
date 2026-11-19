// Nutrition: meals, workouts and weigh-ins. A separate place from notes: none of this is ever a
// capture, a category or a counter. Every number is an estimate meant to give bearings, not a
// measurement. Shared by the server (building and checking entries) and the app (the editable
// card, the totals), so both compute the same thing.

export type NutritionType = 'meal' | 'workout' | 'weight';
/** `proposed`: understood from a capture, waiting for Julien's tap. Only `confirmed` counts. */
export type NutritionStatus = 'proposed' | 'confirmed';
export type NutritionSource = 'voice' | 'text' | 'photo' | 'manual';
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
/**
 * Where an item's values come from: the Ciqual table (Anses), Open Food Facts (a product),
 * the model's own estimate when neither had a match, or numbers typed by hand.
 */
export type FoodSource = 'ciqual' | 'off' | 'estimate' | 'manual';

export interface Macros {
  kcal: number;
  /** Grams. */
  protein: number;
  carbs: number;
  fat: number;
}

export interface FoodItem extends Macros {
  name: string;
  grams: number;
  /** The values per 100 g behind the numbers above: changing the quantity rescales from them. */
  per100: Macros | null;
  source: FoodSource;
  /** What it was matched to in the source ("Banane, chair sans peau, crue"), to spot a wrong match. */
  ref: string | null;
}

export interface MealData {
  slot: MealSlot;
  items: FoodItem[];
}

export interface WorkoutData {
  activity: string;
  minutes: number;
  /** Metabolic equivalent of the activity; kcal = MET × kg × hours. */
  met: number;
  kcal: number;
  /** The body weight used for the estimate (latest weigh-in, or the default). */
  weightKg: number;
}

export interface WeightData {
  kg: number;
}

interface EntryBase {
  id: string;
  clientId: string;
  status: NutritionStatus;
  source: NutritionSource;
  /** Local day it counts for, `YYYY-MM-DD`. */
  day: string;
  occurredAt: string;
  title: string;
  /** What was said or typed (a photo: the caption, then what the model saw). */
  originalText: string;
  hasPhoto: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NutritionEntry = EntryBase &
  ({ type: 'meal'; data: MealData } | { type: 'workout'; data: WorkoutData } | { type: 'weight'; data: WeightData });

export type NutritionData = MealData | WorkoutData | WeightData;

export interface NutritionSettings {
  /** Daily energy target, kcal. */
  kcalGoal: number;
  /** False until Julien sets it: the default is only a placeholder. */
  goalSet: boolean;
}

export interface DayTotals {
  eaten: Macros;
  /** kcal spent in workouts. */
  burned: number;
  goal: number;
  /** goal − eaten + burned: what is left for the day (negative when over). */
  remaining: number;
}

export interface NutritionDay {
  day: string;
  /** Confirmed entries of the day, in the order they happened. */
  entries: NutritionEntry[];
  /** Everything still waiting for a tap, whatever its day. */
  pending: NutritionEntry[];
  totals: DayTotals;
  settings: NutritionSettings;
  /** Most recent weigh-in on or before the day. */
  weight: { kg: number; day: string } | null;
}

export interface HistoryDay extends Macros {
  day: string;
  burned: number;
  /** Last weigh-in of that day, if any. */
  weightKg: number | null;
  meals: number;
  workouts: number;
}

export interface NutritionHistory {
  from: string;
  to: string;
  /** Only days with at least one confirmed entry. */
  days: HistoryDay[];
  settings: NutritionSettings;
}

export const DEFAULT_KCAL_GOAL = 2000;
/** Used for workout estimates until a first weigh-in exists. */
export const DEFAULT_WEIGHT_KG = 75;
export const MAX_ITEMS = 30;
export const MAX_ITEM_NAME = 120;
export const MAX_TITLE = 120;
export const MAX_GRAMS = 5000;
export const MAX_KCAL = 10_000;
export const MIN_WEIGHT_KG = 25;
export const MAX_WEIGHT_KG = 300;
export const MAX_WORKOUT_MINUTES = 24 * 60;
export const MIN_KCAL_GOAL = 800;
export const MAX_KCAL_GOAL = 8000;

export const MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];
export const SLOT_LABEL: Record<MealSlot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
export const SOURCE_LABEL: Record<FoodSource, string> = {
  ciqual: 'Ciqual',
  off: 'Open Food Facts',
  estimate: 'AI estimate',
  manual: 'By hand',
};

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Local calendar day of an instant in a zone. */
export function localDay(instant: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Local hour (0-23) of an instant in a zone. */
export function localHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' }).format(instant);
  return Number(hour) % 24;
}

/** The meal a time of day most likely is, when nothing says it. */
export function slotForHour(hour: number): MealSlot {
  if (hour >= 5 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 15) return 'lunch';
  if (hour >= 18 && hour < 23) return 'dinner';
  return 'snack';
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

/** The values of `grams` of a food, from its values per 100 g. */
export function portion(per100: Macros, grams: number): Macros {
  const f = grams / 100;
  return {
    kcal: Math.round(per100.kcal * f),
    protein: round1(per100.protein * f),
    carbs: round1(per100.carbs * f),
    fat: round1(per100.fat * f),
  };
}

/** New quantity for an item: rescaled from its per-100 g values, or in proportion without them. */
export function withGrams(item: FoodItem, grams: number): FoodItem {
  if (!finite(grams) || grams < 0) return item;
  if (item.per100) return { ...item, grams, ...portion(item.per100, grams) };
  if (item.grams <= 0) return { ...item, grams };
  const f = grams / item.grams;
  return { ...item, grams, kcal: Math.round(item.kcal * f), protein: round1(item.protein * f), carbs: round1(item.carbs * f), fat: round1(item.fat * f) };
}

/** A value typed by hand: the item no longer follows its source. */
export function withValue(item: FoodItem, key: keyof Macros, value: number): FoodItem {
  if (!finite(value) || value < 0) return item;
  return { ...item, [key]: key === 'kcal' ? Math.round(value) : round1(value), per100: null, source: 'manual', ref: null };
}

export function sumMacros(list: readonly Macros[]): Macros {
  const total = list.reduce((a, b) => ({ kcal: a.kcal + b.kcal, protein: a.protein + b.protein, carbs: a.carbs + b.carbs, fat: a.fat + b.fat }), ZERO);
  return { kcal: Math.round(total.kcal), protein: round1(total.protein), carbs: round1(total.carbs), fat: round1(total.fat) };
}

/** Simple and standard: MET × body weight × hours. */
export function workoutKcal(met: number, weightKg: number, minutes: number): number {
  return Math.round(met * weightKg * (minutes / 60));
}

/** Energy of an entry: eaten for a meal, spent for a workout, nothing for a weigh-in. */
export function entryKcal(entry: Pick<NutritionEntry, 'type' | 'data'>): number {
  if (entry.type === 'meal') return sumMacros((entry.data as MealData).items).kcal;
  if (entry.type === 'workout') return (entry.data as WorkoutData).kcal;
  return 0;
}

export function dayTotals(entries: readonly Pick<NutritionEntry, 'type' | 'data' | 'status'>[], goal: number): DayTotals {
  const counted = entries.filter((e) => e.status === 'confirmed');
  const eaten = sumMacros(counted.filter((e) => e.type === 'meal').flatMap((e) => (e.data as MealData).items));
  const burned = counted.filter((e) => e.type === 'workout').reduce((n, e) => n + (e.data as WorkoutData).kcal, 0);
  return { eaten, burned, goal, remaining: goal - eaten.kcal + burned };
}

/** Share of the energy coming from each macro (4 / 4 / 9 kcal per gram), in percent. */
export function macroSplit(m: Macros): { protein: number; carbs: number; fat: number } {
  const p = m.protein * 4;
  const c = m.carbs * 4;
  const f = m.fat * 9;
  const total = p + c + f;
  if (total <= 0) return { protein: 0, carbs: 0, fat: 0 };
  const protein = Math.round((p / total) * 100);
  const carbs = Math.round((c / total) * 100);
  return { protein, carbs, fat: Math.max(0, 100 - protein - carbs) };
}

/**
 * Brings data from the app (an edited card) or from a backup to what may be stored: numbers
 * bounded, names trimmed, totals of an item consistent with nothing but themselves. Returns
 * null when the shape is not that of the type.
 */
export function cleanData(type: NutritionType, raw: unknown): NutritionData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (type === 'weight') {
    if (!finite(r.kg) || r.kg < MIN_WEIGHT_KG || r.kg > MAX_WEIGHT_KG) return null;
    return { kg: round1(r.kg) };
  }
  if (type === 'workout') {
    const activity = typeof r.activity === 'string' ? r.activity.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_NAME) : '';
    if (!activity || !finite(r.minutes) || !finite(r.kcal)) return null;
    if (r.minutes <= 0 || r.minutes > MAX_WORKOUT_MINUTES || r.kcal < 0 || r.kcal > MAX_KCAL) return null;
    return {
      activity,
      minutes: Math.round(r.minutes),
      met: finite(r.met) ? clamp(round1(r.met), 1, 25) : 0,
      kcal: Math.round(r.kcal),
      weightKg: finite(r.weightKg) ? clamp(round1(r.weightKg), MIN_WEIGHT_KG, MAX_WEIGHT_KG) : DEFAULT_WEIGHT_KG,
    };
  }
  if (!Array.isArray(r.items) || r.items.length > MAX_ITEMS) return null;
  const items: FoodItem[] = [];
  for (const rawItem of r.items) {
    const item = cleanItem(rawItem);
    if (!item) return null;
    items.push(item);
  }
  const slot = MEAL_SLOTS.includes(r.slot as MealSlot) ? (r.slot as MealSlot) : 'snack';
  return { slot, items };
}

function cleanMacros(raw: unknown, maxKcal: number): Macros | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (![m.kcal, m.protein, m.carbs, m.fat].every((v) => finite(v) && v >= 0)) return null;
  if ((m.kcal as number) > maxKcal) return null;
  return { kcal: Math.round(m.kcal as number), protein: round1(m.protein as number), carbs: round1(m.carbs as number), fat: round1(m.fat as number) };
}

export function cleanItem(raw: unknown): FoodItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_NAME) : '';
  const totals = cleanMacros(r, MAX_KCAL);
  if (!name || !totals || !finite(r.grams) || r.grams < 0 || r.grams > MAX_GRAMS) return null;
  const source: FoodSource = (['ciqual', 'off', 'estimate', 'manual'] as const).includes(r.source as FoodSource) ? (r.source as FoodSource) : 'manual';
  return {
    name,
    grams: Math.round(r.grams),
    ...totals,
    // Per 100 g, nothing edible goes past pure fat (900 kcal).
    per100: source === 'manual' ? null : cleanMacros(r.per100, 950),
    source,
    ref: typeof r.ref === 'string' && source !== 'manual' ? r.ref.slice(0, 200) : null,
  };
}

/** Null when the entry can be confirmed; otherwise a sentence for the card. */
export function dataProblem(type: NutritionType, data: NutritionData): string | null {
  if (type === 'meal') {
    const meal = data as MealData;
    if (meal.items.length === 0) return 'Add at least one food.';
    if (meal.items.some((i) => !i.name.trim())) return 'Give every food a name.';
    return null;
  }
  if (type === 'workout') {
    const w = data as WorkoutData;
    if (!w.activity.trim()) return 'Say which activity it was.';
    if (!(w.minutes > 0)) return 'Set how long it lasted.';
    return null;
  }
  const kg = (data as WeightData).kg;
  return kg >= MIN_WEIGHT_KG && kg <= MAX_WEIGHT_KG ? null : 'Enter your weight in kg.';
}

/** "Banana, coffee" / "Cycling" / "78.4 kg": what an entry is called when nothing better was said. */
export function defaultTitle(type: NutritionType, data: NutritionData): string {
  if (type === 'meal') {
    const names = (data as MealData).items.map((i) => i.name);
    const text = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
    return (text || 'Meal').slice(0, MAX_TITLE);
  }
  if (type === 'workout') return ((data as WorkoutData).activity || 'Workout').slice(0, MAX_TITLE);
  return `${(data as WeightData).kg} kg`;
}
