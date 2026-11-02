import { buildClassifyMessages, parseClassifyResponse } from './classify-prompt.js';
import { AiUnavailableError, type Ai, type ClassifyInput, type ClassifyResult, type TranscribeInput } from './types.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const TRANSCRIBE_TIMEOUT_MS = 90_000;
const CLASSIFY_TIMEOUT_MS = 20_000;

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
    // The response body can echo request details; keep only the status in errors and logs.
    throw new AiUnavailableError(`Groq ${endpoint} responded ${res.status}`);
  }
  return res.json();
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
  };
}
