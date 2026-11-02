import type { Category } from './categories.js';

export type CaptureKind = 'voice' | 'text' | 'link';
export type CaptureStatus = 'open' | 'done' | 'archived';
export type CategorySource = 'auto' | 'manual' | 'fallback';
export type ClassificationStatus = 'pending' | 'done' | 'failed';

export interface Capture {
  id: string;
  clientId: string;
  kind: CaptureKind;
  title: string | null;
  text: string;
  originalText: string;
  url: string | null;
  category: Category;
  categorySource: CategorySource;
  classificationStatus: ClassificationStatus;
  status: CaptureStatus;
  durationMs: number | null;
  device: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  archivedAt: string | null;
}

export interface Me {
  id: string;
  email: string;
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'invalid_input'
  | 'not_found'
  | 'rate_limited'
  | 'transcription_failed'
  | 'empty_transcription'
  | 'audio_too_large'
  | 'forbidden_origin'
  | 'internal';

export interface ApiError {
  error: ApiErrorCode;
  message: string;
}
