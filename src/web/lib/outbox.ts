import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Capture } from '../../shared/types';
import { api, deviceLabel, RequestError } from './api';

/**
 * Every capture is written here before the first upload attempt and removed only once the
 * server has confirmed it is stored. The clientId travels with each retry, so the server
 * stores it once however many times it is sent. For voice, this is also the only place the
 * audio lives: it is deleted with the item, i.e. right after a confirmed save or a discard.
 *
 * Limits, on purpose: retries run while the app is open (on launch, when the connection
 * comes back, or on "Retry now"). If the browser clears site data, pending items go with it.
 */
interface OutboxBase {
  clientId: string;
  device: string;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  /** The server refused the content itself; automatic retries skip it until edited or discarded. */
  blocked?: boolean;
}

export type OutboxItem =
  | (OutboxBase & { kind: 'text' | 'link'; text: string; url?: string })
  | (OutboxBase & { kind: 'voice'; audio: Blob; mimeType: string; durationMs: number });

export type NewOutboxItem =
  | { kind: 'text' | 'link'; text: string; url?: string }
  | { kind: 'voice'; audio: Blob; mimeType: string; durationMs: number };

interface OutboxDb extends DBSchema {
  outbox: { key: string; value: OutboxItem };
}

let dbPromise: Promise<IDBPDatabase<OutboxDb>> | null = null;
function db(): Promise<IDBPDatabase<OutboxDb>> {
  dbPromise ??= openDB<OutboxDb>('brain-capture', 1, {
    upgrade(database) {
      database.createObjectStore('outbox', { keyPath: 'clientId' });
    },
  });
  return dbPromise;
}

/** Builds an item without storing it (used directly when the device refuses to store). */
export function makeItem(input: NewOutboxItem): OutboxItem {
  const base: OutboxBase = {
    clientId: crypto.randomUUID(),
    device: deviceLabel(),
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  return { ...base, ...input };
}

export async function enqueue(input: NewOutboxItem): Promise<OutboxItem> {
  const item = makeItem(input);
  await (await db()).put('outbox', item);
  notify();
  return item;
}

export async function pendingItems(): Promise<OutboxItem[]> {
  const items = await (await db()).getAll('outbox');
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export async function discard(clientId: string): Promise<void> {
  await (await db()).delete('outbox', clientId);
  notify();
}

export type SendResult =
  | { ok: true; capture: Capture }
  | { ok: false; retryable: boolean; message: string; code: string };

const inFlight = new Map<string, Promise<SendResult>>();

function upload(item: OutboxItem): Promise<Capture> {
  if (item.kind === 'voice') {
    return api.createVoiceCapture({
      clientId: item.clientId,
      audio: item.audio,
      mimeType: item.mimeType,
      durationMs: item.durationMs,
      device: item.device,
    });
  }
  return api.createCapture({ clientId: item.clientId, kind: item.kind, text: item.text, url: item.url, device: item.device });
}

/** Sends one item. Concurrent calls for the same item share a single request. */
export function send(item: OutboxItem): Promise<SendResult> {
  const running = inFlight.get(item.clientId);
  if (running) return running;
  const attempt = (async (): Promise<SendResult> => {
    try {
      let capture: Capture;
      try {
        capture = await upload(item);
      } catch (err) {
        const e = err instanceof RequestError ? err : new RequestError('network', 'No connection right now.', 0);
        // Bookkeeping is best effort: an item that never reached the outbox (device storage
        // refused it) must still get an honest answer. Update only if the item is still
        // there, so a Discard during the request sticks.
        try {
          const tx = (await db()).transaction('outbox', 'readwrite');
          const current = await tx.store.get(item.clientId);
          if (current) {
            await tx.store.put({ ...current, attempts: current.attempts + 1, lastError: e.message, blocked: !e.retryable });
          }
          await tx.done;
        } catch {
          // Local storage unavailable: nothing to update.
        }
        return { ok: false, retryable: e.retryable, message: e.message, code: e.code };
      }
      // The server has it: a failure to clean up locally must not report the save as failed.
      await (async () => (await db()).delete('outbox', item.clientId))().catch(() => undefined);
      for (const l of sentListeners) l(item.clientId, capture);
      return { ok: true, capture };
    } finally {
      inFlight.delete(item.clientId);
      notify();
    }
  })();
  inFlight.set(item.clientId, attempt);
  return attempt;
}

export async function flush(): Promise<void> {
  for (const item of await pendingItems()) {
    if (item.blocked) continue;
    const result = await send(item);
    if (!result.ok && result.retryable) break; // Still offline: no point hammering the rest.
  }
}

/**
 * Fires for every confirmed save, whoever sent it (a screen, the retry loop, the banner).
 * Screens showing a waiting capture use it to move on when it leaves in the background:
 * a static "Not saved yet" over an already saved capture was the real Android bug.
 */
type SentListener = (clientId: string, capture: Capture) => void;
const sentListeners = new Set<SentListener>();
export function onSent(listener: SentListener): () => void {
  sentListeners.add(listener);
  return () => sentListeners.delete(listener);
}

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify(): void {
  for (const l of listeners) l();
}

const FIRST_RETRY_MS = 3_000;
const MAX_RETRY_MS = 30_000;

/**
 * Sends waiting captures on launch, on "online", on return to the foreground, and then keeps
 * retrying with backoff (3 s, 6 s, 12 s, then every 30 s) while something waits and the app
 * is visible. The edge events alone are not enough: Android reports "online" as soon as the
 * interface is up, often seconds before requests go through, and that single early attempt
 * failed with nothing scheduled after it. Nothing runs while the app is in the background.
 */
export function startAutoFlush(): () => void {
  let timer: number | undefined;
  let delay = FIRST_RETRY_MS;
  let stopped = false;

  const clear = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (stopped || timer !== undefined || document.visibilityState !== 'visible') return;
    timer = window.setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  };
  const run = async () => {
    await flush().catch(() => undefined);
    const waiting = (await pendingItems()).some((i) => !i.blocked);
    if (waiting) schedule();
    else delay = FIRST_RETRY_MS;
  };
  // A fresh signal (network back, app reopened) restarts the short delays.
  const kick = () => {
    clear();
    delay = FIRST_RETRY_MS;
    void run();
  };
  const onVisibility = () => (document.visibilityState === 'visible' ? kick() : clear());
  // A capture that just failed in the UI joins the retry cycle without waiting for an event.
  const unsubscribe = subscribe(() => {
    void pendingItems().then((items) => items.some((i) => !i.blocked) && schedule());
  });

  kick();
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stopped = true;
    clear();
    unsubscribe();
    window.removeEventListener('online', kick);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
