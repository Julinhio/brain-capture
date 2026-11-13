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

`scripts/eval-event.ts` does the same for calendar requests (« mets dans mon agenda… »): it checks the event the card would propose, see `docs/calendar-events.md`.

`scripts/eval-new-category.ts` creates a category in an isolated in-memory instance and checks the real classifier sorts into it (same key, same cost).

`scripts/eval-classify.ts` runs the real classifier on representative captures (needs a Groq key, costs a fraction of a cent):

```bash
npx tsx --env-file=<file with GROQ_API_KEY> scripts/eval-classify.ts
```

## How a capture is kept safe

1. The device writes the capture to IndexedDB with a random `clientId` before any network call.
2. The server stores it once per `(owner, clientId)`: a retry after a lost response returns the stored capture instead of a duplicate.
3. Only then is the model asked for a category and title. If that fails, the capture stays under Other and a server-side sweep retries up to three times. A category or title set by hand is never overwritten.
4. The device removes its local copy only after the server confirms. "Saved" is never shown before that.

## Deleting a capture

Archive keeps a capture; **Delete** (next to Archive, in the desktop drawer and the phone's capture view, with a confirmation) removes it for good, with its project links and its calendar suggestion. An event already in Google Calendar is not touched. A small tombstone (`deleted_captures`: ids only, no content) keeps it from coming back: a phone resending it after a lost answer gets `410 capture_deleted` and drops its copy, the classification sweep has nothing left to retry, and restoring an older backup skips it.

A calendar request is not a task: once its event is created in Google, the capture is deleted the same way (`docs/calendar-events.md`).

## Categories

Editable in the app (name and a description of what goes in each); the classifier reads the descriptions, so a new category needs no code change. Other is fixed. Deleting a category archives its captures under Other. Details: `docs/categories.md`.

Known limits: retries run while the app is open (on launch, when the connection comes back, then with backoff up to every 30 s). Clearing the browser's site data removes captures still waiting on the device. Accepted limits and later work: `docs/future-improvements.md`.

## Browser checks

Each script drives Chromium (`playwright-core`, pinned to the locally installed revision) against a running production build and the local test account from `.env`. Each exits non-zero on failure:

| Script | What it proves |
| --- | --- |
| `check-pwa.mjs` | Service worker active, app opens offline, offline capture sent once when back online |
| `check-auto-retry.mjs --path stay\|keep --kind text\|voice` | Network back but failing a few seconds: capture sent once, waiting screen moves to "Saved" by itself |
| `check-double-submit.mjs` | A double tap on Save creates one capture |
| `check-local-write-failure.mjs` | Device storage refusing the write: sheet unlocks, text kept, one capture on retry |
| `check-voice-store-failure.mjs` | Same for a recording (sent from memory, honest screen offline); needs Groq |
| `check-voice-rejected.mjs` | A recording refused by transcription (422) is not retried automatically, can be saved as a file, stays reachable from the banner, and survives "Record again" |
| `check-cancel-while-starting.mjs` | Cancel during the microphone prompt starts nothing and releases the mic |
| `check-voice-browser.mjs` | Real MediaRecorder audio through Groq to "Saved"; needs Groq |
| `check-share.mjs` | A share opened at `/share` is saved once (run on the Vite dev server to cover StrictMode replays); if storage fails, the shared content reopens prefilled instead of being lost |
| `check-desktop-bar.mjs` | Desktop quick bar and search: storage failure, double Enter, background save, refusals, line breaks, drawer errors |
| `check-today.mjs` | Today: My day collapsed by default and remembered once expanded, both radar cards with six rows and the same height |
| `check-categories-delete.mjs` | Categories created, renamed and deleted from the app; Delete with confirmation in the drawer and on the phone; the calendar hand-off removing the capture |

Without Playwright's own Chromium, `BROWSER_CHANNEL=chrome` (or `msedge`) runs `check-today.mjs` and `check-categories-delete.mjs` on an installed browser.

## Backup and restore

Owner-level JSON export and import through the app (`GET /api/export`, `POST /api/import`); the import only adds missing captures. `scripts/backup.mjs` saves a file, `scripts/restore.mjs` restores one, `scripts/check-restore.mjs` proves a file restores field by field into an isolated local instance. Procedure, costs and limits: `docs/backup-restore.md`.

## Deploy (test deployment on Railway)

One app service and one PostgreSQL in the personal project `brain-capture`. Deploys are manual uploads of a clean checkout, marked with the commit so the running version can be checked without creating a capture:

```bash
railway variable set APP_VERSION=$(git rev-parse --short HEAD) --service brain-capture --skip-deploys
railway up --service brain-capture --ci
curl https://brain-capture-production-8fa2.up.railway.app/api/health   # {"ok":true,"version":"<commit>"}
```

The same version shows at the bottom of History (phone) and of the desktop sidebar. Migrations run at boot and only add; existing captures are kept across deploys.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Railway (reference to the Postgres service) | `postgres://…` in production, `pglite:<dir>` locally |
| `OWNER_EMAIL`, `OWNER_PASSWORD_HASH` | Railway | The single account, created or updated at boot. Changing the hash signs every device out. |
| `GROQ_API_KEY` | Railway | Transcription, sorting and reading calendar requests |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `CALENDAR_ENCRYPTION_KEY` | Railway | Google Calendar: dashboard reading, events added from captures |
| `ALLOWED_ORIGINS` | local `.env` only | Extra origins allowed to send state-changing requests (the Vite dev proxy) |
| `GROQ_TRANSCRIBE_MODEL`, `GROQ_CLASSIFY_MODEL` | optional | Model overrides |
| `APP_VERSION` | Railway, set by the deploy | Commit shown in the app and returned by `/api/health` |
| `NODE_ENV=production`, `NPM_CONFIG_INCLUDE=dev` | Railway | Production mode at runtime; build tools still installed for the build |

Secrets stay out of the repository: production values in Railway variables, local ones in `.env` (gitignored).
