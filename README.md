# Brain Capture

Private PWA to drop an idea, a task, a link or a job offer the moment it shows up (phone first), and find it sorted later on the desktop.

One owner account, no sign-up. React + Vite on the front, Fastify + PostgreSQL (Drizzle) on the back, Groq for transcription (`whisper-large-v3-turbo`) and sorting (`openai/gpt-oss-20b`). Hosted on Railway: one app service, one PostgreSQL.

## Run locally

```bash
npm install
cp .env.example .env   # then fill OWNER_EMAIL / OWNER_PASSWORD_HASH
npm run dev            # API on :3000, app on http://localhost:5173
```

Local data lives in PGlite (an in-process PostgreSQL) under `.data/`, so no database server is needed. Without `GROQ_API_KEY` the app still saves captures; they land in Other until a key is configured.

Password hash for `OWNER_PASSWORD_HASH`:

```bash
echo <password> | npx tsx scripts/hash-password.ts
```

## Checks

```bash
npm test          # API tests against a real PostgreSQL engine (PGlite)
npm run typecheck
npm run build
```

`scripts/eval-classify.ts` runs the real classifier on representative captures (needs a Groq key, costs a fraction of a cent):

```bash
npx tsx --env-file=<file with GROQ_API_KEY> scripts/eval-classify.ts
```

## How a capture is kept safe

1. The device writes the capture to IndexedDB with a random `clientId` before any network call.
2. The server stores it once per `(owner, clientId)`: a retry after a lost response returns the stored capture instead of a duplicate.
3. Only then is the model asked for a category and title. If that fails, the capture stays under Other and a server-side sweep retries up to three times. A category or title set by hand is never overwritten.
4. The device removes its local copy only after the server confirms. "Saved" is never shown before that.

Known limits: retries run while the app is open (launch, connection back, "Retry now"). Clearing the browser's site data removes captures still waiting on the device.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Railway (reference to the Postgres service) | `postgres://…` in production, `pglite:<dir>` locally |
| `OWNER_EMAIL`, `OWNER_PASSWORD_HASH` | Railway | The single account, created or updated at boot. Changing the hash signs every device out. |
| `GROQ_API_KEY` | Railway | Transcription and sorting |
| `ALLOWED_ORIGINS` | local `.env` only | Extra origins allowed to send state-changing requests (the Vite dev proxy) |
| `GROQ_TRANSCRIBE_MODEL`, `GROQ_CLASSIFY_MODEL` | optional | Model overrides |

Secrets stay out of the repository: production values in Railway variables, local ones in `.env` (gitignored).
