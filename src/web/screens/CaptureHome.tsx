import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Clock, Link2, Type } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Capture } from '../../shared/types';
import { CaptureView } from '../components/CaptureView';
import { ComposeSheet, type ComposeValue } from '../components/ComposeSheet';
import { discard, enqueue, flush, pendingItems, send, subscribe, type OutboxItem } from '../lib/outbox';
import { navigate } from '../lib/router';
import { clockTime, relativeTime } from '../lib/time';
import { useRecentCaptures } from '../lib/useCaptures';

type Mode =
  | { name: 'home' }
  | { name: 'compose'; kind: 'text' | 'link'; initial?: ComposeValue; replaces?: string }
  | { name: 'saving'; item: OutboxItem }
  | { name: 'not-saved'; item: OutboxItem; message: string; retryable: boolean }
  | { name: 'saved'; capture: Capture };

export function TopBar() {
  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => navigate('/')}>
        <span className="brand-mark" aria-hidden="true" />
        Brain Capture
      </button>
      <button type="button" className="pill-btn" onClick={() => navigate('/history')}>
        <Clock size={16} aria-hidden="true" />
        History
      </button>
    </header>
  );
}

function usePendingItems(): OutboxItem[] {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<OutboxItem[]>([]);
  useEffect(() => {
    const refresh = () => void pendingItems().then(setItems);
    refresh();
    return subscribe(() => {
      refresh();
      // An item leaving the outbox in the background is a new capture on the server.
      void queryClient.invalidateQueries({ queryKey: ['captures'] });
    });
  }, [queryClient]);
  return items;
}

export function CaptureHome() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>({ name: 'home' });
  const recent = useRecentCaptures(3);
  const pending = usePendingItems();
  const blocked = pending.find((i) => i.blocked);

  /** Rejects only if the device write fails; once stored, every later step handles its own errors. */
  async function save(kind: 'text' | 'link', value: ComposeValue, replaces?: string) {
    // Stored on the device first: from here on, closing the app cannot lose it.
    const item = await enqueue({ kind, text: value.text, url: value.url });
    // The new copy exists: a failure removing the old one must not unlock the sheet (it
    // would invite a duplicate). Worst case the old draft stays listed as waiting.
    if (replaces) await discard(replaces).catch(() => undefined);
    await attempt(item);
  }

  async function attempt(item: OutboxItem) {
    setMode({ name: 'saving', item });
    const result = await send(item);
    if (result.ok) {
      setMode({ name: 'saved', capture: result.capture });
      void queryClient.invalidateQueries({ queryKey: ['captures'] });
    } else {
      setMode({ name: 'not-saved', item, message: result.message, retryable: result.retryable });
    }
  }

  if (mode.name === 'saving') {
    return (
      <main className="screen">
        <TopBar />
        <div className="status-view" aria-live="polite">
          <h1>Saving…</h1>
          <p className="lead">Not saved yet. It stays on this device until it is.</p>
          <div className="list" style={{ marginTop: 24 }}>
            <div className="list-item" style={{ cursor: 'default' }}>
              <Check size={18} color="var(--success)" aria-hidden="true" />
              <span className="grow">Kept on this device</span>
            </div>
            <div className="list-item" style={{ cursor: 'default' }}>
              <span className="spinner" aria-hidden="true" />
              <span className="grow">Saving and sorting</span>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (mode.name === 'not-saved') {
    return <NotSaved mode={mode} onRetry={() => attempt(mode.item)} onEdit={() => setMode({
      name: 'compose',
      kind: mode.item.kind,
      initial: { text: mode.item.text, url: mode.item.url },
      replaces: mode.item.clientId,
    })} onDone={() => setMode({ name: 'home' })} />;
  }

  if (mode.name === 'saved') {
    const c = mode.capture;
    return (
      <main className="screen">
        <TopBar />
        <div style={{ marginTop: 16 }}>
          <CaptureView
            capture={c}
            onChange={(capture) => setMode({ name: 'saved', capture })}
            header={
              <p className="saved-head" role="status">
                <Check size={18} aria-hidden="true" /> Saved <span className="mono">· {clockTime(c.createdAt)}</span>
              </p>
            }
          />
        </div>
        <div className="bottom-bar">
          <button type="button" className="btn" onClick={() => setMode({ name: 'home' })}>
            Done
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setMode({ name: 'compose', kind: c.kind === 'link' ? 'link' : 'text' })}>
            New capture
          </button>
        </div>
      </main>
    );
  }

  const latest = recent.data ?? [];

  return (
    <main className="screen">
      <TopBar />
      <section className="hero">
        <h1>What’s on your mind?</h1>
        <p>Write it or paste a link. It gets sorted for you.</p>
      </section>

      <div className="capture-actions">
        <button type="button" className="capture-action" onClick={() => setMode({ name: 'compose', kind: 'text' })}>
          <span className="icon-btn" style={{ width: 88, height: 88 }}>
            <Type size={28} aria-hidden="true" />
          </span>
          Text
        </button>
        <button type="button" className="capture-action" onClick={() => setMode({ name: 'compose', kind: 'link' })}>
          <span className="icon-btn" style={{ width: 88, height: 88 }}>
            <Link2 size={28} aria-hidden="true" />
          </span>
          Link
        </button>
      </div>

      {pending.length > 0 && (
        <div className="banner" role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <span className="grow">
            {blocked
              ? 'A capture could not be saved as is.'
              : `${pending.length === 1 ? '1 capture is' : `${pending.length} captures are`} waiting to be saved.`}
          </span>
          {blocked ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                setMode({ name: 'not-saved', item: blocked, message: blocked.lastError ?? 'The server refused it.', retryable: false })
              }
            >
              Review
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => void flush()}>
              Retry now
            </button>
          )}
        </div>
      )}

      <section className="recent" aria-labelledby="recent-title">
        <div className="section-head">
          <span id="recent-title" className="mono">
            Recent
          </span>
          <button type="button" className="link-btn" onClick={() => navigate('/history')}>
            See all
          </button>
        </div>
        <div className="list">
          {recent.isError && <p className="empty">Could not load your captures. Pull down or try again later.</p>}
          {recent.isSuccess && latest.length === 0 && <p className="empty">Nothing yet. Your first capture will show up here.</p>}
          {latest.map((c) => (
            <button key={c.id} type="button" className="list-item" data-cat={c.category} onClick={() => navigate(`/history?id=${c.id}`)}>
              <span className="cat-dot" aria-hidden="true" />
              <span className="grow">{c.title ?? c.text}</span>
              <span className="meta">{relativeTime(c.createdAt)}</span>
            </button>
          ))}
        </div>
      </section>

      {mode.name === 'compose' && (
        <ComposeSheet
          kind={mode.kind}
          initial={mode.initial}
          onClose={() => setMode({ name: 'home' })}
          onSubmit={(value) => save(mode.kind, value, mode.replaces)}
        />
      )}
    </main>
  );
}

function NotSaved({
  mode,
  onRetry,
  onEdit,
  onDone,
}: {
  mode: Extract<Mode, { name: 'not-saved' }>;
  onRetry: () => void;
  onEdit: () => void;
  onDone: () => void;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  return (
    <main className="screen">
      <TopBar />
      <div className="status-view" role="alert">
        <div className={`status-icon ${mode.retryable ? 'warn' : 'error'}`} aria-hidden="true">
          <AlertTriangle size={22} />
        </div>
        <h1>Not saved yet</h1>
        {mode.retryable ? (
          <p className="lead">
            {mode.message} Your capture is safe on this device. It is sent again when the app is open and online.
          </p>
        ) : (
          <p className="lead">{mode.message} Edit it or discard it.</p>
        )}
        <div className="status-footer">
          {mode.retryable ? (
            <button type="button" className="btn btn-primary btn-block" onClick={onRetry}>
              Retry now
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-block" onClick={onEdit}>
              Edit
            </button>
          )}
          {mode.retryable && (
            <button type="button" className="btn btn-block" onClick={onDone}>
              Keep it for later
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger-text btn-block"
            onClick={() => {
              if (!confirmDiscard) return setConfirmDiscard(true);
              void discard(mode.item.clientId).then(onDone);
            }}
          >
            {confirmDiscard ? 'Tap again to discard for good' : 'Discard'}
          </button>
        </div>
      </div>
    </main>
  );
}
