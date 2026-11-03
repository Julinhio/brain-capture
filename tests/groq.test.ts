import { describe, expect, it } from 'vitest';
import { createGroqAi } from '../src/server/ai/groq.js';
import { AiRejectedError, AiUnavailableError } from '../src/server/ai/types.js';

function aiAnswering(status: number, body: string) {
  const fetchImpl = (async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  return createGroqAi({ apiKey: 'gsk_test', transcribeModel: 'whisper-large-v3-turbo', classifyModel: 'm', fetchImpl });
}

const audio = { audio: Buffer.from([1, 2, 3]), filename: 'recording.webm', mimeType: 'audio/webm' };

describe('Groq error handling', () => {
  it('a 413 refusal is final and keeps the provider explanation', async () => {
    const ai = aiAnswering(
      413,
      JSON.stringify({ error: { message: 'Request Entity Too Large', type: 'invalid_request_error', code: 'request_too_large' } }),
    );
    const err = await ai.transcribe(audio).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRejectedError);
    expect((err as AiRejectedError).detail).toEqual({
      status: 413,
      type: 'invalid_request_error',
      code: 'request_too_large',
      message: 'Request Entity Too Large',
    });
  });

  it.each([400, 415, 422])('%i is a refusal of this input', async (status) => {
    await expect(aiAnswering(status, '{"error":{"message":"could not process file"}}').transcribe(audio)).rejects.toBeInstanceOf(
      AiRejectedError,
    );
  });

  it.each([429, 500, 503, 401, 404])('%i stays retryable (rate limit, outage, key or model problem)', async (status) => {
    await expect(aiAnswering(status, '{"error":{"message":"try later"}}').transcribe(audio)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('scrubs anything that looks like a key and bounds the message', async () => {
    const err = (await aiAnswering(413, JSON.stringify({ error: { message: `bad key gsk_abcDEF123 ${'x'.repeat(1000)}` } }))
      .transcribe(audio)
      .catch((e: unknown) => e)) as AiRejectedError;
    expect(err.detail.message).not.toContain('gsk_abc');
    expect(err.detail.message).toContain('[key]');
    expect(err.detail.message!.length).toBeLessThanOrEqual(300);
  });

  it('keeps a non-JSON body as the message', async () => {
    const err = (await aiAnswering(413, '<html>Request Entity Too Large</html>').transcribe(audio).catch((e: unknown) => e)) as AiRejectedError;
    expect(err.detail.message).toBe('<html>Request Entity Too Large</html>');
  });
});
