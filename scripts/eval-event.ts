/**
 * Runs the real event extraction on representative calendar requests and checks the draft
 * the card would show. Notes without an explicit request never reach the model (the gate
 * in event-prompt.ts), so they are checked here without any call.
 * Usage: npx tsx --env-file=<path to .env with GROQ_API_KEY> scripts/eval-event.ts
 * Free tier: about ten short completions, paced to stay under the per-minute token limit.
 */
import { pathToFileURL } from 'node:url';
import { looksLikeCalendarRequest, normalizeExtraction } from '../src/server/ai/event-prompt.js';
import { createGroqAi } from '../src/server/ai/groq.js';
import { zonedToUtc, type EventDraft } from '../src/shared/event.js';

// Wednesday 11 November 2026, 20:15 in Paris.
const PARIS_EVENING = new Date('2026-11-11T19:15:00Z');
// Same instant seen from Da Nang: already Thursday 12 November, 02:15.
const DA_NANG = 'Asia/Ho_Chi_Minh';

interface Case {
  text: string;
  timeZone: string;
  reference: Date;
  expect: Partial<EventDraft> | 'not-a-request';
}

const CASES: Case[] = [
  {
    text: 'Mets dans mon agenda dentiste mardi prochain à 15 h',
    timeZone: 'Europe/Paris',
    reference: PARIS_EVENING,
    expect: { allDay: false, start: '2026-11-17T15:00', end: '2026-11-17T16:00', startTimeZone: 'Europe/Paris' },
  },
  {
    text: 'Add to my calendar lunch with Sarah on Friday at 12:30 at Café Lomi',
    timeZone: 'Europe/Paris',
    reference: PARIS_EVENING,
    expect: { allDay: false, start: '2026-11-13T12:30', end: '2026-11-13T13:30' },
  },
  {
    text: 'Ajoute à mon agenda le vol TP433 Paris Lisbonne vendredi 20 novembre départ 8 h 30 arrivée 10 h 05',
    timeZone: 'Europe/Paris',
    reference: PARIS_EVENING,
    expect: {
      allDay: false,
      start: '2026-11-20T08:30',
      startTimeZone: 'Europe/Paris',
      end: '2026-11-20T10:05',
      endTimeZone: 'Europe/Lisbon',
    },
  },
  {
    text: "Mets dans mon calendrier l'anniversaire de Marie le 3 décembre",
    timeZone: 'Europe/Paris',
    reference: PARIS_EVENING,
    expect: { allDay: true, start: '2026-12-03', end: '2026-12-03' },
  },
  {
    text: 'Ajoute dans mon agenda réunion Automata demain de 14 h à 16 h 30',
    timeZone: 'Europe/Paris',
    reference: PARIS_EVENING,
    expect: { allDay: false, start: '2026-11-12T14:00', end: '2026-11-12T16:30' },
  },
  {
    // Same words, phone in Da Nang where it is already Thursday: next Tuesday is still the 17th,
    // but "demain" is Friday 13 there.
    text: 'Mets dans mon agenda padel demain à 7 h',
    timeZone: DA_NANG,
    reference: PARIS_EVENING,
    expect: { allDay: false, start: '2026-11-13T07:00', startTimeZone: DA_NANG },
  },
  {
    text: 'Put a call with the New York recruiter in my calendar next Monday at 10am New York time',
    timeZone: 'Europe/Paris',
    reference: PARIS_EVENING,
    expect: { allDay: false, start: '2026-11-16T10:00', startTimeZone: 'America/New_York' },
  },
  {
    text: "Penser à mettre à jour l'agenda partagé de l'équipe",
    timeZone: 'Europe/Paris',
    reference: PARIS_EVENING,
    expect: 'not-a-request',
  },
];

const GATE_ONLY = [
  'Demain, penser à regarder cette offre',
  'Réunion mardi 15 h avec Paul',
  'Regarder mon agenda pour la semaine prochaine',
  'Check my calendar before replying to Tom on Friday',
];

async function main(): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is missing (pass --env-file)');
  const ai = createGroqAi({
    apiKey,
    transcribeModel: 'whisper-large-v3-turbo',
    classifyModel: process.env.GROQ_CLASSIFY_MODEL || 'openai/gpt-oss-20b',
  });
  const delayMs = Number(process.env.EVAL_DELAY_MS ?? 12_000);
  let ok = 0;
  let total = 0;

  for (const text of GATE_ONLY) {
    total += 1;
    const fired = looksLikeCalendarRequest(text);
    if (!fired) ok += 1;
    console.log(`${fired ? 'XX ' : 'OK '} gate stays quiet   ${text}`);
  }

  for (const [i, c] of CASES.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    total += 1;
    if (!looksLikeCalendarRequest(c.text)) {
      const pass = c.expect === 'not-a-request';
      if (pass) ok += 1;
      console.log(`${pass ? 'OK ' : 'XX '} gate quiet          ${c.text}`);
      continue;
    }
    const t0 = Date.now();
    try {
      const raw = await ai.extractEvent({ text: c.text, reference: c.reference, timeZone: c.timeZone });
      const ms = Date.now() - t0;
      if (c.expect === 'not-a-request') {
        const pass = !raw.isEventRequest;
        if (pass) ok += 1;
        console.log(`${pass ? 'OK ' : 'XX '} model says ${raw.isEventRequest ? 'request' : 'no request'} ${ms}ms  ${c.text}`);
        continue;
      }
      const draft = normalizeExtraction(raw, { timeZone: c.timeZone, fallbackTitle: 'Événement' });
      const wrong = Object.entries(c.expect).filter(([k, v]) => draft[k as keyof EventDraft] !== v);
      const pass = raw.isEventRequest && wrong.length === 0;
      if (pass) ok += 1;
      const when = draft.start && !draft.allDay ? zonedToUtc(draft.start, draft.startTimeZone).toISOString() : draft.start;
      console.log(
        `${pass ? 'OK ' : 'XX '} ${ms}ms  "${draft.title}" ${draft.start} (${draft.startTimeZone}) → ${draft.end} (${draft.endTimeZone}) ` +
          `loc=${draft.location ?? '-'} utc=${when}${wrong.length ? `  MISMATCH ${wrong.map(([k]) => k).join(',')}` : ''}`,
      );
    } catch (err) {
      console.log(`ERR ${(err as Error).message}  ${c.text}`);
    }
  }
  console.log(`\n${ok}/${total} as expected`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
