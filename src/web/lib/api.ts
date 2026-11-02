import type { ApiError, ApiErrorCode, Capture, CaptureStatus, Me } from '../../shared/types';
import type { Category } from '../../shared/categories';

/** `network` means the request never got an answer: the capture is still safe on the device. */
export class RequestError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'network',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RequestError';
  }

  /** False only when sending the same thing again can never work (invalid content). */
  get retryable(): boolean {
    return this.code === 'network' || this.status >= 500 || this.status === 429 || this.status === 401;
  }
}

// A 401 anywhere means the session is gone (expired, password changed on another device):
// the app must fall back to the sign-in screen instead of failing request after request.
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

// A request stuck on a flaky network would hold its outbox item "in flight" indefinitely.
// Past these limits it counts as a network failure; the retry is safe because the server
// deduplicates on clientId. Voice allows for upload plus a slow transcription.
const DEFAULT_TIMEOUT_MS = 45_000;
const VOICE_TIMEOUT_MS = 180_000;

async function request<T>(method: string, path: string, body?: unknown | FormData, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined || body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RequestError('network', 'No connection right now.', 0);
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') for (const l of unauthorizedListeners) l();
    let payload: Partial<ApiError> = {};
    try {
      payload = (await res.json()) as ApiError;
    } catch {
      // Proxies and cold starts answer with HTML; the status is all we need then.
    }
    throw new RequestError(payload.error ?? (res.status >= 500 ? 'internal' : 'invalid_input'), payload.message ?? `Request failed (${res.status}).`, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => request<Me | null>('GET', '/api/me'),
  login: (email: string, password: string) => request<Me>('POST', '/api/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  listCaptures: (params: { status?: CaptureStatus | 'all'; category?: Category; limit?: number; before?: string | null } = {}) => {
    const qs = new URLSearchParams({ status: params.status ?? 'open' });
    if (params.category) qs.set('category', params.category);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.before) qs.set('before', params.before);
    return request<{ captures: Capture[]; nextCursor: string | null }>('GET', `/api/captures?${qs}`);
  },
  getCapture: (id: string) => request<{ capture: Capture }>('GET', `/api/captures/${id}`).then((r) => r.capture),
  createCapture: (input: { clientId: string; kind: 'text' | 'link'; text: string; url?: string; device: string }) =>
    request<{ capture: Capture; created: boolean }>('POST', '/api/captures', input).then((r) => r.capture),
  createVoiceCapture: (input: { clientId: string; audio: Blob; mimeType: string; durationMs: number; device: string }) => {
    const form = new FormData();
    // Fields first: the server reads them before the file stream.
    form.append('clientId', input.clientId);
    form.append('durationMs', String(Math.round(input.durationMs)));
    form.append('device', input.device);
    form.append('audio', input.audio, `recording.${extensionFor(input.mimeType)}`);
    return request<{ capture: Capture; created: boolean }>('POST', '/api/captures/voice', form, VOICE_TIMEOUT_MS).then((r) => r.capture);
  },
  updateCapture: (id: string, patch: { title?: string; text?: string; category?: Category; status?: CaptureStatus }) =>
    request<{ capture: Capture }>('PATCH', `/api/captures/${id}`, patch).then((r) => r.capture),
};

// Whisper picks the decoder from the file extension, so it has to match the container.
function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  return 'desktop';
}
