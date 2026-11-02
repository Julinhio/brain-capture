export interface Config {
  env: 'production' | 'development' | 'test';
  port: number;
  databaseUrl: string;
  groqApiKey: string | null;
  transcribeModel: string;
  classifyModel: string;
  ownerEmail: string | null;
  ownerPasswordHash: string | null;
  /** Origins allowed to send state-changing requests; empty means "same host as the request". */
  allowedOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const databaseUrl = env.DATABASE_URL ?? (mode === 'production' ? '' : 'pglite:.data/pglite');
  if (!databaseUrl) throw new Error('DATABASE_URL is required in production');

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);

  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase() || null;
  const ownerPasswordHash = env.OWNER_PASSWORD_HASH?.trim() || null;
  if (Boolean(ownerEmail) !== Boolean(ownerPasswordHash)) {
    throw new Error('OWNER_EMAIL and OWNER_PASSWORD_HASH must be set together');
  }
  if (ownerPasswordHash && !ownerPasswordHash.startsWith('$argon2id$')) {
    throw new Error('OWNER_PASSWORD_HASH must be an argon2id hash (see scripts/hash-password.ts)');
  }

  return {
    env: mode,
    port,
    databaseUrl,
    groqApiKey: env.GROQ_API_KEY?.trim() || null,
    transcribeModel: env.GROQ_TRANSCRIBE_MODEL?.trim() || 'whisper-large-v3-turbo',
    classifyModel: env.GROQ_CLASSIFY_MODEL?.trim() || 'openai/gpt-oss-20b',
    ownerEmail,
    ownerPasswordHash,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
