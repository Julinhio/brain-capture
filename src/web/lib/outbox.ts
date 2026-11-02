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

export async function enqueue(input: NewOutboxItem): Promise<OutboxItem> {
  const base: OutboxBase = {
    clientId: crypto.randomUUID(),
    device: deviceLabel(),
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  const item: OutboxItem = { ...base, ...input };
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
      const capture = await upload(item);
      await (await db()).delete('outbox', item.clientId);
      return { ok: true, capture };
    } catch (err) {
      const e = err instanceof RequestError ? err : new RequestError('network', 'No connection right now.', 0);
      // Update only if the item is still there: a Discard during the request must stick.
      const tx = (await db()).transaction('outbox', 'readwrite');
      const current = await tx.store.get(item.clientId);
      if (current) {
        await tx.store.put({ ...current, attempts: current.attempts + 1, lastError: e.message, blocked: !e.retryable });
      }
      await tx.done;
      return { ok: false, retryable: e.retryable, message: e.message, code: e.code };
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

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify(): void {
  for (const l of listeners) l();
}

export function startAutoFlush(): () => void {
  const run = () => void flush().catch(() => undefined);
  run();
  window.addEventListener('online', run);
  const onVisible = () => document.visibilityState === 'visible' && run();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('online', run);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
