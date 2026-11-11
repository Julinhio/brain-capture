import { buildClassifyMessages, parseClassifyResponse } from './classify-prompt.js';
import { buildEventMessages, parseEventResponse } from './event-prompt.js';
import {
  AiRejectedError,
  AiUnavailableError,
  type Ai,
  type ClassifyInput,
  type ClassifyResult,
  type EventExtractInput,
  type EventExtraction,
  type ProviderErrorDetail,
  type TranscribeInput,
} from './types.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const TRANSCRIBE_TIMEOUT_MS = 90_000;
const CLASSIFY_TIMEOUT_MS = 20_000;
const EVENT_TIMEOUT_MS = 25_000;

interface GroqOptions {
  apiKey: string;
  transcribeModel: string;
  classifyModel: string;
  fetchImpl?: typeof fetch;
}

async function groqFetch(
  fetchImpl: typeof fetch,
  apiKey: string,
  endpoint: string,
  body: FormData | string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${GROQ_BASE}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AiUnavailableError(`Groq ${endpoint} unreachable`, err);
  }
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    const summary = `Groq ${endpoint} responded ${res.status}${detail.code || detail.type ? ` (${detail.code ?? detail.type})` : ''}`;
    // Only a refusal of this very input is final. Rate limits, outages, a bad key or an
    // unknown model are fixed elsewhere, so the capture must keep waiting and retrying.
    if (REJECTION_STATUSES.has(res.status)) throw new AiRejectedError(summary, detail);
    throw new AiUnavailableError(summary, undefined, detail);
  }
  return res.json();
}

// Statuses where the request itself is refused: same bytes, same answer.
const REJECTION_STATUSES = new Set([400, 413, 415, 422]);

/**
 * Keeps Groq's own explanation, which the status alone hides (a 413 on a 23 KB upload is
 * not about bytes). Bounded and scrubbed: it ends up in logs and on the person's screen.
 */
async function readErrorDetail(res: Response): Promise<ProviderErrorDetail> {
  const detail: ProviderErrorDetail = { status: res.status };
  let raw = '';
  try {
    raw = (await res.text()).slice(0, 4000);
    const body = JSON.parse(raw) as { error?: { message?: unknown; type?: unknown; code?: unknown } };
    const e = body.error ?? {};
    if (typeof e.type === 'string') detail.type = clean(e.type, 60);
    if (typeof e.code === 'string') detail.code = clean(e.code, 60);
    if (typeof e.message === 'string') detail.message = clean(e.message, 300);
  } catch {
    if (raw) detail.message = clean(raw, 300);
  }
  return detail;
}

function clean(value: string, max: number): string {
  return value
    .replace(/gsk_[A-Za-z0-9]+/g, '[key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function createGroqAi(options: GroqOptions): Ai {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    available: true,
    async transcribe(input: TranscribeInput) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(input.audio)], { type: input.mimeType }), input.filename);
      form.append('model', options.transcribeModel);
      form.append('response_format', 'json');
      form.append('temperature', '0');
      // No `language`: Julien speaks French or English, Whisper detects it per recording.
      const data = (await groqFetch(fetchImpl, options.apiKey, '/audio/transcriptions', form, TRANSCRIBE_TIMEOUT_MS)) as {
        text?: unknown;
      };
      if (typeof data.text !== 'string') throw new AiUnavailableError('Groq transcription returned no text');
      return { text: data.text.trim() };
    },

    async classify(input: ClassifyInput): Promise<ClassifyResult> {
      const body = JSON.stringify({
        model: options.classifyModel,
        messages: buildClassifyMessages(input),
        response_format: { type: 'json_object' },
        reasoning_effort: 'low',
        max_completion_tokens: 400,
      });
      const data = (await groqFetch(fetchImpl, options.apiKey, '/chat/completions', body, CLASSIFY_TIMEOUT_MS, {
        'Content-Type': 'application/json',
      })) as { choices?: { message?: { content?: unknown } }[] };
      const content = data.choices?.[0]?.message?.content;
      const result = typeof content === 'string' ? parseClassifyResponse(content) : null;
      if (!result) throw new AiUnavailableError('Groq classification returned an unusable answer');
      return result;
    },

    async extractEvent(input: EventExtractInput): Promise<EventExtraction> {
      const body = JSON.stringify({
        model: options.classifyModel,
        messages: buildEventMessages(input),
        response_format: { type: 'json_object' },
        reasoning_effort: 'medium',
        max_completion_tokens: 2000,
      });
      const data = (await groqFetch(fetchImpl, options.apiKey, '/chat/completions', body, EVENT_TIMEOUT_MS, {
        'Content-Type': 'application/json',
      })) as { choices?: { message?: { content?: unknown } }[] };
      const content = data.choices?.[0]?.message?.content;
      const result = typeof content === 'string' ? parseEventResponse(content) : null;
      if (!result) throw new AiUnavailableError('Groq event extraction returned an unusable answer');
      return result;
    },
  };
}

/** Used when no key is configured (local dev without secrets): captures still save, sorted as Other. */
export function createUnavailableAi(): Ai {
  return {
    available: false,
    async transcribe() {
      throw new AiUnavailableError('Transcription is not configured (GROQ_API_KEY missing)');
    },
    async classify() {
      throw new AiUnavailableError('Classification is not configured (GROQ_API_KEY missing)');
    },
    async extractEvent() {
      throw new AiUnavailableError('Event extraction is not configured (GROQ_API_KEY missing)');
    },
  };
}
