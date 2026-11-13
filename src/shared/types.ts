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
  | 'transcription_rejected'
  | 'empty_transcription'
  | 'audio_too_large'
  | 'forbidden_origin'
  /** Google refused because the connection expired or lacks the right: reconnect. */
  | 'calendar_reconnect'
  | 'calendar_unavailable'
  /** The capture was deleted for good: a device still holding it must drop it. */
  | 'capture_deleted'
  | 'internal';

export interface ApiError {
  error: ApiErrorCode;
  message: string;
}
