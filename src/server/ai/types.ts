import type { Category, CategoryInfo } from '../../shared/categories.js';
import type { CaptureKind } from '../../shared/types.js';

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
