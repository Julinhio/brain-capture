export interface Config {
  env: 'production' | 'development' | 'test';
  port: number;
  databaseUrl: string;
  groqApiKey: string | null;
  transcribeModel: string;
  classifyModel: string;
  ownerEmail: string | null;
  ownerPasswordHash: string | null;
  /** Commit of the running build, set by the deploy (APP_VERSION); "dev" otherwise. */
  appVersion: string;
  /** Origins allowed to send state-changing requests; empty means "same host as the request". */
  allowedOrigins: string[];
  calendar: { clientId: string; clientSecret: string; redirectUri: string; encryptionKey: string; calendarId: string } | null;
  radars: { jobs: { token: string; url: string | null }; automata: { token: string; url: string | null } };
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

  const googleParts = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI, env.CALENDAR_ENCRYPTION_KEY];
  if (googleParts.some(Boolean) && !googleParts.every(Boolean)) throw new Error('Set all four Google Calendar OAuth variables together');
  if (env.CALENDAR_ENCRYPTION_KEY && !/^[a-f0-9]{64}$/i.test(env.CALENDAR_ENCRYPTION_KEY)) throw new Error('CALENDAR_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters');
  if (env.GOOGLE_REDIRECT_URI) {
    const redirect = new URL(env.GOOGLE_REDIRECT_URI);
    if (redirect.pathname !== '/api/calendar/callback' || redirect.search || redirect.hash || redirect.username || redirect.password || (redirect.protocol !== 'https:' && !(mode !== 'production' && redirect.origin === 'http://localhost:3000'))) throw new Error('Invalid GOOGLE_REDIRECT_URI');
  }
  function radar(token = '', value?: string) {
    if (token && token.length < 32) throw new Error('Radar summary tokens must contain at least 32 characters');
    if (value) {
      const u = new URL(value);
      if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(mode !== 'production' && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw new Error('Invalid radar URL');
    }
    return { token, url: value || null };
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
    appVersion: env.APP_VERSION?.trim() || 'dev',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    calendar: googleParts.every(Boolean) ? { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, redirectUri: env.GOOGLE_REDIRECT_URI!, encryptionKey: env.CALENDAR_ENCRYPTION_KEY!, calendarId: env.GOOGLE_CALENDAR_ID || 'primary' } : null,
    radars: { jobs: radar(env.RADAR_JOBS_TOKEN, env.RADAR_JOBS_URL), automata: radar(env.RADAR_AUTOMATA_TOKEN, env.RADAR_AUTOMATA_URL) },
  };
}
