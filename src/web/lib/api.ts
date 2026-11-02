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

async function request<T>(method: string, path: string, body?: unknown | FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined || body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new RequestError('network', 'No connection right now.', 0);
  }
  if (!res.ok) {
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
  listCaptures: (status: CaptureStatus | 'all' = 'open') =>
    request<{ captures: Capture[] }>('GET', `/api/captures?status=${status}`).then((r) => r.captures),
  createCapture: (input: { clientId: string; kind: 'text' | 'link'; text: string; url?: string; device: string }) =>
    request<{ capture: Capture; created: boolean }>('POST', '/api/captures', input).then((r) => r.capture),
  updateCapture: (id: string, patch: { title?: string; text?: string; category?: Category; status?: CaptureStatus }) =>
    request<{ capture: Capture }>('PATCH', `/api/captures/${id}`, patch).then((r) => r.capture),
};

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  return 'desktop';
}
