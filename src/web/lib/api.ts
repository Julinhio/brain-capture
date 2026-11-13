import type { ApiError, ApiErrorCode, Capture, CaptureStatus, Me } from '../../shared/types';
import type { Category, CategoryInfo } from '../../shared/categories';
import type { CalendarDay, Project, ProjectState, RadarSummary, TodayData } from '../../shared/dashboard';
import type { CaptureEventResponse, EventDraft } from '../../shared/event';

export interface Overview {
  counts: Record<Category, number>;
  done: number;
  archived: number;
  recent: number;
  sections: Record<Category, Capture[]>;
}

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

  /** False only when sending the same thing again can never work (invalid content, deleted). */
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
  today: (timeZone: string) => request<TodayData>('GET', `/api/today?${new URLSearchParams({ timeZone })}`),
  radars: () => request<{ jobs: RadarSummary; automata: RadarSummary }>('GET', '/api/radars'),
  calendarDay: (timeZone: string) => request<CalendarDay>('GET', `/api/calendar/day?${new URLSearchParams({ timeZone })}`),
  /** `returnTo`: path of this app the browser comes back to after Google's consent screen. */
  connectCalendar: (returnTo?: string) => request<{ url: string }>('POST', '/api/calendar/connect', returnTo ? { returnTo } : {}),
  captureEvent: (captureId: string) => request<CaptureEventResponse>('GET', `/api/captures/${captureId}/event`),
  confirmEvent: (captureId: string, draft: EventDraft) =>
    request<CaptureEventResponse>('POST', `/api/captures/${captureId}/event`, { draft }),
  setEventState: (captureId: string, state: 'proposed' | 'dismissed') =>
    request<CaptureEventResponse>('PATCH', `/api/captures/${captureId}/event`, { state }),
  saveEventDraft: (captureId: string, draft: EventDraft) =>
    request<CaptureEventResponse>('PATCH', `/api/captures/${captureId}/event`, { draft }),
  rereadEvent: (captureId: string) => request<CaptureEventResponse>('POST', `/api/captures/${captureId}/event/extract`),
  disconnectCalendar: () => request<{ ok: true }>('DELETE', '/api/calendar/connection'),
  selectCalendars: (calendarIds: string[] | null) => request<{ ok: true }>('PATCH', '/api/calendar/selection', { calendarIds }),
  projects: () => request<{ projects: Project[] }>('GET', '/api/projects').then((r) => r.projects),
  createProject: (input: { name: string; intention: string; state: ProjectState; nextStep: string; captureId?: string }) => request<{ id: string }>('POST', '/api/projects', input),
  updateProject: (id: string, patch: Partial<Pick<Project, 'name' | 'intention' | 'state' | 'nextStep'>>) => request<{ id: string }>('PATCH', `/api/projects/${id}`, patch),
  projectCaptures: (id: string) => request<{ captures: Capture[] }>('GET', `/api/projects/${id}/captures`).then((r) => r.captures),
  captureProjects: (id: string) => request<{ projectIds: string[] }>('GET', `/api/captures/${id}/projects`).then((r) => r.projectIds),
  linkProject: (projectId: string, captureId: string, linked: boolean) => request<{ ok: true }>(linked ? 'PUT' : 'DELETE', `/api/projects/${projectId}/captures/${captureId}`),
  me: () => request<Me | null>('GET', '/api/me'),
  login: (email: string, password: string) => request<Me>('POST', '/api/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  overview: () => request<Overview>('GET', '/api/overview'),
  listCaptures: (
    params: { status?: CaptureStatus | 'all'; category?: Category; q?: string; limit?: number; before?: string | null } = {},
  ) => {
    const qs = new URLSearchParams({ status: params.status ?? 'open' });
    if (params.category) qs.set('category', params.category);
    if (params.q) qs.set('q', params.q);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.before) qs.set('before', params.before);
    return request<{ captures: Capture[]; nextCursor: string | null }>('GET', `/api/captures?${qs}`);
  },
  getCapture: (id: string) => request<{ capture: Capture }>('GET', `/api/captures/${id}`).then((r) => r.capture),
  createCapture: (input: {
    clientId: string;
    kind: 'text' | 'link';
    text: string;
    url?: string;
    device: string;
    capturedAt?: number;
    timeZone?: string;
  }) =>
    request<{ capture: Capture; created: boolean }>('POST', '/api/captures', input).then((r) => r.capture),
  createVoiceCapture: (input: {
    clientId: string;
    audio: Blob;
    mimeType: string;
    durationMs: number;
    device: string;
    capturedAt?: number;
    timeZone?: string;
  }) => {
    const form = new FormData();
    // Fields first: the server reads them before the file stream.
    form.append('clientId', input.clientId);
    form.append('durationMs', String(Math.round(input.durationMs)));
    form.append('device', input.device);
    if (input.capturedAt !== undefined) form.append('capturedAt', String(Math.round(input.capturedAt)));
    if (input.timeZone) form.append('timeZone', input.timeZone);
    form.append('audio', input.audio, `recording.${extensionFor(input.mimeType)}`);
    return request<{ capture: Capture; created: boolean }>('POST', '/api/captures/voice', form, VOICE_TIMEOUT_MS).then((r) => r.capture);
  },
  updateCapture: (id: string, patch: { title?: string; text?: string; category?: Category; status?: CaptureStatus }) =>
    request<{ capture: Capture }>('PATCH', `/api/captures/${id}`, patch).then((r) => r.capture),
  deleteCapture: (id: string) => request<{ deleted: true }>('DELETE', `/api/captures/${id}`),
  categories: () => request<{ categories: CategoryInfo[] }>('GET', '/api/categories').then((r) => r.categories),
  createCategory: (input: { name: string; description: string }) =>
    request<{ category: CategoryInfo }>('POST', '/api/categories', input).then((r) => r.category),
  updateCategory: (id: string, patch: { name?: string; description?: string }) =>
    request<{ category: CategoryInfo }>('PATCH', `/api/categories/${id}`, patch).then((r) => r.category),
  deleteCategory: (id: string) => request<{ archived: number }>('DELETE', `/api/categories/${id}`),
};

// Whisper picks the decoder from the file extension, so it has to match the container.
function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  return 'desktop';
}
