import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, Check, Clock, Download, Link2, Mic, MicOff, Share2, Square, Type, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Capture } from '../../shared/types';
import { CaptureView } from '../components/CaptureView';
import { CategoryIcon } from '../components/CategoryIcon';
import { ComposeSheet, type ComposeValue } from '../components/ComposeSheet';
import { discard, enqueue, flush, makeItem, onSent, pendingItems, send, subscribe, type NewOutboxItem, type OutboxItem } from '../lib/outbox';
import { canShareRecording, downloadRecording, shareRecording } from '../lib/recordingFile';
import { sharedToCapture, type SharedData } from '../../shared/share';
import { navigate, useSearchParam } from '../lib/router';
import { clockTime, formatDuration, relativeTime } from '../lib/time';
import { useRecentCaptures } from '../lib/useCaptures';
import { MAX_RECORDING_MS, useRecorder, type RecorderError, type Recording } from '../lib/useRecorder';

type Mode =
  | { name: 'home' }
  | { name: 'compose'; kind: 'text' | 'link'; initial?: ComposeValue; replaces?: string; storeFailed?: boolean }
  // `unstored`: the device refused to keep it (storage full or blocked). It then lives only in
  // this screen's memory, so nothing may suggest it is safe to walk away.
  | { name: 'saving'; item: OutboxItem; notice?: string; unstored?: boolean }
  | { name: 'not-saved'; item: OutboxItem; message: string; retryable: boolean; unstored?: boolean }
  | { name: 'saved'; capture: Capture; notice?: string };

const MIC_ERRORS: Record<RecorderError, string> = {
  'permission-denied': 'Microphone access is blocked. Allow it for this site in your browser settings, or write it down instead.',
  'no-microphone': 'No microphone was found on this device. Write it down instead.',
  unsupported: 'This browser cannot record audio. Write it down instead.',
  failed: 'The microphone could not start. Try again, or write it down.',
};

export function TopBar() {
  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => navigate('/')}>
        <span className="brand-mark" aria-hidden="true" />
        Brain Capture
      </button>
      <button type="button" className="pill-btn" onClick={() => navigate('/?view=today')} aria-label="Aujourd’hui"><CalendarDays size={16} aria-hidden="true" /></button>
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

// A share opens /share once per page load; StrictMode and re-renders must not save it twice.
let handledShare: string | null = null;

export function CaptureHome({ share }: { share?: SharedData } = {}) {
  const queryClient = useQueryClient();
  const composeParam = useSearchParam('compose');
  const [mode, setMode] = useState<Mode>(() =>
    composeParam === 'text' || composeParam === 'link' ? { name: 'compose', kind: composeParam } : { name: 'home' },
  );
  const recent = useRecentCaptures(3);
  const pending = usePendingItems();
  const blocked = pending.find((i) => i.blocked);
  // The capture the screen is following. A save that finishes after Julien moved on to a
  // new capture must not pull the screen back to it.
  const followed = useRef<string | null>(null);

  const recorder = useRecorder((recording: Recording) => {
    const notice =
      recording.endedBecause === 'interrupted'
        ? 'Recording stopped when the app was left. What you said until then is kept.'
        : recording.endedBecause === 'limit'
          ? 'Recording stopped at the 10 minute limit.'
          : undefined;
    const input: NewOutboxItem = { kind: 'voice', audio: recording.blob, mimeType: recording.mimeType, durationMs: recording.durationMs };
    // If the device cannot store the recording, still send it straight from memory rather
    // than dropping what was just said.
    save(input, undefined, notice).catch(() => attempt(makeItem(input), notice, true));
  });

  /** Rejects only if the device write fails; once stored, every later step handles its own errors. */
  async function save(input: NewOutboxItem, replaces?: string, notice?: string) {
    // Stored on the device first: from here on, closing the app cannot lose it.
    const item = await enqueue(input);
    // The new copy exists: a failure removing the old one must not unlock the sheet (it
    // would invite a duplicate). Worst case the old draft stays listed as waiting.
    if (replaces) await discard(replaces).catch(() => undefined);
    await attempt(item, notice);
  }

  async function attempt(item: OutboxItem, notice?: string, unstored = false) {
    followed.current = item.clientId;
    setMode({ name: 'saving', item, notice, unstored });
    const result = await send(item);
    if (followed.current !== item.clientId) return;
    if (result.ok) {
      setMode({ name: 'saved', capture: result.capture, notice });
      void queryClient.invalidateQueries({ queryKey: ['captures'] });
    } else {
      setMode({ name: 'not-saved', item, message: result.message, retryable: result.retryable, unstored });
    }
  }

  // The followed capture can be saved by the retry loop while this screen shows "Saving…" or
  // "Not saved yet". Follow it to "Saved", otherwise the screen lies (and Discard would only
  // drop the local copy of something already stored).
  useEffect(
    () =>
      onSent((clientId, capture) => {
        if (followed.current !== clientId) return;
        setMode((prev) =>
          (prev.name === 'saving' || prev.name === 'not-saved') && prev.item.clientId === clientId
            ? { name: 'saved', capture, notice: prev.name === 'saving' ? prev.notice : undefined }
            : prev,
        );
        void queryClient.invalidateQueries({ queryKey: ['captures'] });
      }),
    [queryClient],
  );

  function goHome() {
    followed.current = null;
    setMode({ name: 'home' });
  }

  useEffect(() => {
    if (!share) return;
    // Keyed on the shared payload itself, not on the URL: the URL changes as soon as /share
    // is left below, so a replayed effect (StrictMode, re-render) would see a new key.
    const key = `${performance.timeOrigin}:${JSON.stringify([share.title, share.text, share.url])}`;
    if (handledShare === key) return;
    handledShare = key;
    // Leave /share right away so a reload or "back" does not save it a second time. /capture,
    // not /: on desktop "/" is the dashboard, which would unmount the saving and recovery screens.
    navigate('/capture', { replace: true });
    const shared = sharedToCapture(share);
    if (!shared) {
      setMode({ name: 'compose', kind: 'text' });
      return;
    }
    const value: ComposeValue = shared.kind === 'link' ? { text: shared.text, url: shared.url } : { text: shared.text };
    // If the device refuses to store it, the URL is already gone: reopen the shared content in
    // the compose sheet, prefilled and with the storage error, instead of dropping it.
    save({ kind: shared.kind, ...value }).catch(() =>
      setMode({ name: 'compose', kind: shared.kind, initial: value, storeFailed: true }),
    );
  }, [share]);

  useEffect(() => {
    if (composeParam) navigate('/', { replace: true });
  }, [composeParam]);

  function startRecording() {
    followed.current = null;
    setMode({ name: 'home' });
    void recorder.start();
  }

  if (recorder.state.name === 'starting' || recorder.state.name === 'recording') {
    return <RecordingView elapsed={recorder.elapsed} levels={recorder.levels} onStop={recorder.stop} onCancel={recorder.cancel} starting={recorder.state.name === 'starting'} />;
  }

  if (recorder.state.name === 'error') {
    const error = recorder.state.error;
    return (
      <main className="screen">
        <TopBar />
        <div className="status-view" role="alert">
          <div className="status-icon error" aria-hidden="true">
            <MicOff size={22} />
          </div>
          <h1>Can’t record</h1>
          <p className="lead">{MIC_ERRORS[error]}</p>
          <div className="status-footer">
            <button type="button" className="btn btn-primary btn-block" onClick={() => { recorder.reset(); setMode({ name: 'compose', kind: 'text' }); }}>
              <Type size={18} aria-hidden="true" /> Write it instead
            </button>
            {error !== 'unsupported' && error !== 'no-microphone' && (
              <button type="button" className="btn btn-block" onClick={startRecording}>
                Try again
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-block" onClick={() => { recorder.reset(); goHome(); }}>
              Back
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (mode.name === 'saving') {
    return <SavingView mode={mode} onAnother={goHome} />;
  }

  if (mode.name === 'not-saved') {
    const { item } = mode;
    return (
      <NotSaved
        mode={mode}
        onRetry={() => void attempt(item, undefined, mode.unstored)}
        onEdit={
          item.kind === 'voice'
            ? undefined
            : () => setMode({ name: 'compose', kind: item.kind, initial: { text: item.text, url: item.url }, replaces: item.clientId })
        }
        // Recording again keeps the refused note: it stays on the device (and in the Review
        // banner) until it is saved, retried or discarded on purpose.
        onRecordAgain={item.kind === 'voice' ? startRecording : undefined}
        onDone={goHome}
      />
    );
  }

  if (mode.name === 'saved') {
    const c = mode.capture;
    return (
      <main className="screen">
        <TopBar />
        <div style={{ marginTop: 16 }}>
          <CaptureView
            capture={c}
            onChange={(capture) => setMode({ name: 'saved', capture, notice: mode.notice })}
            header={
              <>
                <p className="saved-head" role="status">
                  <Check size={18} aria-hidden="true" /> Saved{' '}
                  <span className="mono">
                    · {clockTime(c.createdAt)}
                    {c.durationMs ? ` · ${formatDuration(c.durationMs)}` : ''}
                  </span>
                </p>
                {mode.notice && <p className="hint">{mode.notice}</p>}
              </>
            }
          />
        </div>
        <div className="bottom-bar">
          <button type="button" className="btn" onClick={goHome}>
            Done
          </button>
          {c.kind === 'voice' ? (
            <button type="button" className="btn btn-primary" onClick={startRecording}>
              <Mic size={18} aria-hidden="true" /> Record
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setMode({ name: 'compose', kind: c.kind === 'link' ? 'link' : 'text' })}>
              New capture
            </button>
          )}
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
        <p>Tap and talk. It gets sorted for you.</p>
      </section>

      <div className="capture-actions">
        <button type="button" className="capture-action" onClick={() => setMode({ name: 'compose', kind: 'text' })}>
          <span className="icon-btn">
            <Type size={22} aria-hidden="true" />
          </span>
          Text
        </button>
        <button type="button" className="capture-action capture-action-primary" onClick={startRecording} aria-label="Record a voice note">
          <span className="icon-btn">
            <Mic size={44} aria-hidden="true" />
          </span>
        </button>
        <button type="button" className="capture-action" onClick={() => setMode({ name: 'compose', kind: 'link' })}>
          <span className="icon-btn">
            <Link2 size={22} aria-hidden="true" />
          </span>
          Link
        </button>
      </div>

      {pending.length > 0 && (
        <div className="banner" role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <span className="grow">
            {blocked
              ? blocked.kind === 'voice'
                ? 'A recording was refused by transcription. It is kept on this device.'
                : 'A capture could not be saved as is.'
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
          {recent.isError && <p className="empty">Could not load your captures. Check your connection.</p>}
          {recent.isSuccess && latest.length === 0 && <p className="empty">Nothing yet. Your first capture will show up here.</p>}
          {latest.map((c) => (
            <button key={c.id} type="button" className="list-item" data-cat={c.category} onClick={() => navigate(`/history?id=${c.id}`)}>
              <CategoryIcon category={c.category} />
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
          initialStoreError={mode.storeFailed}
          onClose={goHome}
          onSubmit={(value) => save({ kind: mode.kind, text: value.text, url: value.url }, mode.replaces)}
        />
      )}
    </main>
  );
}

function RecordingView({
  elapsed,
  levels,
  onStop,
  onCancel,
  starting,
}: {
  elapsed: number;
  levels: number[];
  onStop: () => void;
  onCancel: () => void;
  starting: boolean;
}) {
  return (
    <main className="screen recording">
      <p className="recording-badge" role="status">
        <span className="rec-dot" aria-hidden="true" />
        {starting ? 'Starting…' : 'Recording'}
      </p>
      <div className="recording-center">
        <p className="recording-timer" aria-label={`Elapsed ${formatDuration(elapsed)}`}>
          {formatDuration(elapsed)}
        </p>
        <div className="wave" aria-hidden="true">
          {levels.map((l, i) => (
            <span key={i} style={{ transform: `scaleY(${0.08 + l * 0.92})` }} />
          ))}
        </div>
        <p className="lead" style={{ textAlign: 'center', maxWidth: 280 }}>
          Speak freely. You’ll see the text once you stop.
        </p>
      </div>
      <div className="recording-controls">
        <button type="button" className="capture-action" onClick={onCancel}>
          <span className="icon-btn">
            <X size={22} aria-hidden="true" />
          </span>
          Cancel
        </button>
        <button type="button" className="capture-action stop-action" onClick={onStop} disabled={starting} aria-label="Stop and save">
          <span className="icon-btn">
            <Square size={30} fill="currentColor" aria-hidden="true" />
          </span>
          Stop
        </button>
        <span className="mono recording-max">max {formatDuration(MAX_RECORDING_MS)}</span>
      </div>
    </main>
  );
}

function SavingView({ mode, onAnother }: { mode: Extract<Mode, { name: 'saving' }>; onAnother: () => void }) {
  const voice = mode.item.kind === 'voice';
  return (
    <main className="screen">
      <TopBar />
      <div className="status-view" aria-live="polite">
        <h1>Saving…</h1>
        <p className="lead">Not saved yet. It stays on this device until it is.</p>
        <div className="list" style={{ marginTop: 24 }}>
          <div className="list-item" style={{ cursor: 'default' }}>
            <Check size={18} color="var(--success)" aria-hidden="true" />
            <span className="grow">{voice ? 'Recorded' : 'Kept on this device'}</span>
            {mode.item.kind === 'voice' && <span className="meta mono">{formatDuration(mode.item.durationMs)}</span>}
          </div>
          <div className="list-item" style={{ cursor: 'default' }}>
            <span className="spinner" aria-hidden="true" />
            <span className="grow">{voice ? 'Uploading and transcribing' : 'Saving'}</span>
          </div>
          <div className="list-item" style={{ cursor: 'default', color: 'var(--text-faint)' }}>
            <span className="step-dot" aria-hidden="true" />
            <span className="grow">Sorting into a category</span>
          </div>
        </div>
        {mode.notice && <p className="hint">{mode.notice}</p>}
        <div className="status-footer">
          {mode.unstored ? (
            // Not on the device: if this upload fails after the screen is left, nothing is left
            // to retry. Keep the person here until it is saved or the failure is shown.
            <p className="hint" style={{ textAlign: 'center', margin: 0 }}>
              This device could not keep it. Stay on this screen until it is saved.
            </p>
          ) : (
            <>
              <button type="button" className="btn btn-block" onClick={onAnother}>
                Start another capture
              </button>
              <p className="hint" style={{ textAlign: 'center', margin: 0 }}>
                This one keeps saving in the background.
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/** Copies the waiting recording out of the app; the app keeps its own copy either way. */
function RecordingCopyActions({ item, primary }: { item: Extract<OutboxItem, { kind: 'voice' }>; primary: boolean }) {
  const [shareFailed, setShareFailed] = useState(false);
  return (
    <>
      <button type="button" className={`btn btn-block ${primary ? 'btn-primary' : ''}`} onClick={() => downloadRecording(item)}>
        <Download size={18} aria-hidden="true" /> Save a copy
      </button>
      {canShareRecording(item) && (
        <button
          type="button"
          className="btn btn-block"
          onClick={() =>
            void shareRecording(item).catch((err: unknown) => {
              // Closing the share sheet is not a failure worth reporting.
              if ((err as DOMException).name !== 'AbortError') setShareFailed(true);
            })
          }
        >
          <Share2 size={18} aria-hidden="true" /> Share
        </button>
      )}
      {shareFailed && <p className="field-error">Sharing did not work. Use “Save a copy” instead.</p>}
    </>
  );
}

function NotSaved({
  mode,
  onRetry,
  onEdit,
  onRecordAgain,
  onDone,
}: {
  mode: Extract<Mode, { name: 'not-saved' }>;
  onRetry: () => void;
  onEdit?: () => void;
  onRecordAgain?: () => void;
  onDone: () => void;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const voice = mode.item.kind === 'voice';
  return (
    <main className="screen">
      <TopBar />
      <div className="status-view" role="alert">
        <div className={`status-icon ${mode.retryable ? 'warn' : 'error'}`} aria-hidden="true">
          <AlertTriangle size={22} />
        </div>
        <h1>Not saved yet</h1>
        {mode.unstored ? (
          <p className="lead">
            {mode.message} This device could not keep the {voice ? 'recording' : 'capture'}: it only exists on this screen. Retry
            while it is open; leaving the screen loses it.
          </p>
        ) : mode.retryable ? (
          <p className="lead">
            {mode.message} Your {voice ? 'recording' : 'capture'} is safe on this device. It is sent automatically while the app is
            open, and this screen updates as soon as it is saved.
          </p>
        ) : voice ? (
          <p className="lead">
            {mode.message} The recording is kept on this device and is not retried automatically. Save a copy to keep it outside
            the app, try again later, or record it again.
          </p>
        ) : (
          <p className="lead">{mode.message}</p>
        )}
        {mode.item.kind === 'voice' && (
          <div className="list" style={{ marginTop: 24 }}>
            <div className="list-item" style={{ cursor: 'default' }}>
              <span className="rec-dot" style={{ background: 'var(--warning)' }} aria-hidden="true" />
              <span className="grow">
                {mode.unstored ? 'Only on this screen' : mode.retryable ? 'Retrying automatically' : 'Recording kept on this device'}
              </span>
              <span className="meta mono">{formatDuration(mode.item.durationMs)}</span>
            </div>
          </div>
        )}
        <div className="status-footer">
          {mode.retryable && (
            <>
              <button type="button" className="btn btn-primary btn-block" onClick={onRetry}>
                Retry now
              </button>
            </>
          )}
          {mode.item.kind === 'voice' && <RecordingCopyActions item={mode.item} primary={!mode.retryable} />}
          {!mode.retryable && (mode.unstored || voice) && (
            <button type="button" className={`btn btn-block ${mode.unstored ? 'btn-primary' : ''}`} onClick={onRetry}>
              Try again
            </button>
          )}
          {!mode.retryable && onEdit && (
            <button type="button" className="btn btn-primary btn-block" onClick={onEdit}>
              Edit
            </button>
          )}
          {!mode.retryable && onRecordAgain && (
            <button type="button" className="btn btn-block" onClick={onRecordAgain}>
              <Mic size={18} aria-hidden="true" /> Record again
            </button>
          )}
          {/* Whenever the capture is on the device (waiting or refused), leaving is safe: it
              stays there and the home banner leads back to it. */}
          {!mode.unstored && (mode.retryable || voice) && (
            <button type="button" className="btn btn-block" onClick={onDone}>
              Keep it for later
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger-text btn-block"
            onClick={() => {
              if (!confirmDiscard) return setConfirmDiscard(true);
              // An unstored capture has no local copy to delete; never get stuck on this screen.
              void discard(mode.item.clientId).catch(() => undefined).then(onDone);
            }}
          >
            {confirmDiscard ? 'Tap again to discard for good' : voice ? 'Discard recording' : 'Discard'}
          </button>
        </div>
      </div>
    </main>
  );
}
