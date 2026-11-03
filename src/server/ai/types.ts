import type { Category } from '../../shared/categories.js';
import type { CaptureKind } from '../../shared/types.js';

export interface ClassifyInput {
  kind: CaptureKind;
  text: string;
  url: string | null;
}

export interface ClassifyResult {
  category: Category;
  title: string;
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
