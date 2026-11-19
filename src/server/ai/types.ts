import type { Category, CategoryInfo } from '../../shared/categories.js';
import type { MealSlot } from '../../shared/nutrition.js';
import type { CaptureKind } from '../../shared/types.js';

/** What a capture is: a note (sorted into a category), or something for the Nutrition section. */
export type CaptureIntent = 'note' | 'meal' | 'workout' | 'weight';

export interface ClassifyInput {
  kind: CaptureKind;
  text: string;
  url: string | null;
  /** The owner's categories at the time of the call; the answer must be one of them. */
  categories: readonly CategoryInfo[];
}

export interface ClassifyResult {
  category: Category;
  title: string;
  /**
   * A first reading only: a meal, workout or weight is then read in full by extractNutrition,
   * which has the last word. Absent means a note.
   */
  intent?: CaptureIntent;
}

export interface NutritionExtractInput {
  text: string;
  /** When the capture was made, on the phone, and its zone: "hier soir" is read from them. */
  reference: Date;
  timeZone: string;
}

export interface PhotoInput {
  image: Buffer;
  mimeType: string;
  /** The optional sentence typed with the photo. */
  caption: string;
  reference: Date;
  timeZone: string;
}

export interface ExtractedFood {
  name: string;
  /** Generic French name, for the food table lookup. */
  nameFr: string;
  brand: string | null;
  grams: number;
  /** The model's own estimate per 100 g: the fallback, and the sanity check of a table match. */
  kcal100: number;
  protein100: number;
  carbs100: number;
  fat100: number;
}

/** The model's answer, already bounded (see nutrition-prompt.ts), before any food lookup. */
export interface NutritionExtraction {
  type: 'meal' | 'workout' | 'weight' | 'none';
  /** 0 = the day of the capture, -1 = the day before. */
  dayOffset: number;
  title: string;
  slot: MealSlot | null;
  items: ExtractedFood[];
  activity: string | null;
  minutes: number | null;
  met: number | null;
  /** Calories burned when the note or the screen gives them. */
  kcal: number | null;
  kg: number | null;
  /** Photos: what the picture shows, and the text read in it when it is not for Nutrition. */
  description: string;
  text: string;
}

export interface EventExtractInput {
  text: string;
  /** When the capture was made, on the phone; relative dates are computed from it. */
  reference: Date;
  /** The phone's IANA zone at capture time. */
  timeZone: string;
}

/** The model's raw answer, before normalisation (see event-prompt.ts). */
export interface EventExtraction {
  isEventRequest: boolean;
  title: string;
  allDay: boolean;
  start: string | null;
  startTimeZone: string | null;
  end: string | null;
  endTimeZone: string | null;
  location: string | null;
}

export interface TranscribeInput {
  audio: Buffer;
  filename: string;
  mimeType: string;
}

export interface Ai {
  /** False when no provider is configured: callers must not spend retry attempts on it. */
  readonly available: boolean;
  transcribe(input: TranscribeInput): Promise<{ text: string }>;
  classify(input: ClassifyInput): Promise<ClassifyResult>;
  extractEvent(input: EventExtractInput): Promise<EventExtraction>;
  extractNutrition(input: NutritionExtractInput): Promise<NutritionExtraction>;
  readPhoto(input: PhotoInput): Promise<NutritionExtraction>;
}

/** What the provider said when it refused a request (short, safe to log and to show). */
export interface ProviderErrorDetail {
  status: number;
  type?: string;
  code?: string;
  message?: string;
}

/** Raised for failures the caller should surface as "try again", never as data loss. */
export class AiUnavailableError extends Error {
  constructor(
    message: string,
    cause?: unknown,
    readonly detail?: ProviderErrorDetail,
  ) {
    super(message, { cause });
    this.name = 'AiUnavailableError';
  }
}

/**
 * The provider refused this particular input (400, 413, 415, 422…). Sending the same bytes
 * again cannot succeed, so callers must stop retrying on their own and say so.
 */
export class AiRejectedError extends Error {
  constructor(
    message: string,
    readonly detail: ProviderErrorDetail,
  ) {
    super(message);
    this.name = 'AiRejectedError';
  }
}
