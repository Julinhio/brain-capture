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
  transcribe(input: TranscribeInput): Promise<{ text: string }>;
  classify(input: ClassifyInput): Promise<ClassifyResult>;
}

/** Raised for failures the caller should surface as "try again", never as data loss. */
export class AiUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AiUnavailableError';
  }
}
