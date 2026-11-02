import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CATEGORIES, CATEGORY_HINTS, CATEGORY_LABELS, isCategory, type Category } from '../../shared/categories';
import { extractUrl, hostOf, normalizeUrl } from '../../shared/text';
import type { Capture, CaptureStatus } from '../../shared/types';
import { Drawer } from '../components/Drawer';
import { discard, enqueue, onSent, send, type OutboxItem } from '../lib/outbox';
import { navigate, useSearchParam } from '../lib/router';
import { clockTime, formatDuration, relativeTime } from '../lib/time';
import { useCapturePages, useOverview } from '../lib/useCaptures';

type View = { kind: 'home' } | { kind: 'category'; category: Category } | { kind: 'status'; status: Exclude<CaptureStatus, 'open'> };

function parseView(raw: string | null): View {
  if (isCategory(raw)) return { kind: 'category', category: raw };
  if (raw === 'done' || raw === 'archived') return { kind: 'status', status: raw };
  return { kind: 'home' };
}

function href(params: { view?: string | null; id?: string | null; q?: string | null }): string {
  const qs = new URLSearchParams();
  if (params.view) qs.set('view', params.view);
  if (params.q) qs.set('q', params.q);
  if (params.id) qs.set('id', params.id);
  const s = qs.toString();
  return s ? `/?${s}` : '/';
}

export function Dashboard() {
  const rawView = useSearchParam('view');
  const openId = useSearchParam('id');
  const q = useSearchParam('q') ?? '';
  const view = parseView(rawView);
  const overview = useOverview();

  const open = (id: string) => navigate(href({ view: rawView, q, id }));
  const close = () => navigate(href({ view: rawView, q }), { replace: true });

  return (
    <div className="desk">
      <aside className="desk-side">
        <button type="button" className="brand desk-brand" onClick={() => navigate('/')}>
          <span className="brand-mark" aria-hidden="true" />
          Brain Capture
        </button>
        <nav aria-label="Sections">
          <SideLink active={view.kind === 'home' && !q} onClick={() => navigate('/')} label="Everything" count={overview.data ? sum(overview.data.counts) : undefined} />
          <p className="mono side-title">Categories</p>
          {CATEGORIES.map((c) => (
            <SideLink
              key={c}
              cat={c}
              active={view.kind === 'category' && view.category === c}
              onClick={() => navigate(href({ view: c }))}
              label={CATEGORY_LABELS[c]}
              count={overview.data?.counts[c]}
            />
          ))}
          <hr className="side-rule" />
          <SideLink active={view.kind === 'status' && view.status === 'done'} onClick={() => navigate(href({ view: 'done' }))} label="Done" count={overview.data?.done} />
          <SideLink
            active={view.kind === 'status' && view.status === 'archived'}
            onClick={() => navigate(href({ view: 'archived' }))}
            label="Archived"
            count={overview.data?.archived}
          />
        </nav>
        <p className="side-sync">
          <span className={`rec-dot ${overview.isError ? 'off' : ''}`} aria-hidden="true" />
          {overview.isError ? 'Offline. Showing what was loaded.' : overview.dataUpdatedAt ? `Updated ${clockTime(new Date(overview.dataUpdatedAt).toISOString())}` : 'Loading…'}
        </p>
      </aside>

      <main className="desk-main">
        <div className="desk-bar">
          <CaptureBar />
          <SearchBox initial={q} onSearch={(value) => navigate(href({ view: rawView, q: value }))} />
        </div>

        {q ? (
          // Search looks everywhere (open, done, archived): a finished item is still worth finding.
          <ListView title={`Results for “${q}”`} status="all" q={q} onOpen={open} />
        ) : view.kind === 'home' ? (
          <Home onOpen={open} />
        ) : view.kind === 'category' ? (
          <ListView title={CATEGORY_LABELS[view.category]} subtitle={CATEGORY_HINTS[view.category]} status="open" category={view.category} onOpen={open} />
        ) : (
          <ListView title={view.status === 'done' ? 'Done' : 'Archived'} status={view.status} onOpen={open} />
        )}
      </main>

      {openId && <Drawer key={openId} id={openId} onClose={close} />}
    </div>
  );
}

function sum(counts: Record<Category, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function SideLink({ label, count, active, onClick, cat }: { label: string; count?: number; active: boolean; onClick: () => void; cat?: Category }) {
  return (
    <button type="button" className="side-link" aria-current={active ? 'page' : undefined} onClick={onClick} data-cat={cat}>
      {cat && <span className="cat-dot" aria-hidden="true" />}
      <span className="grow">{label}</span>
      {count !== undefined && <span className="mono side-count">{count}</span>}
    </button>
  );
}

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? 'Good evening.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
}

function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const overview = useOverview();
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const data = overview.data;

  return (
    <>
      <header className="desk-hello">
        <p className="mono">{today}</p>
        <h1>{greeting()}</h1>
        <p className="lead">
          {data
            ? data.recent === 0
              ? 'Nothing new in the last 24 hours. Everything below is already sorted.'
              : `${data.recent} new ${data.recent === 1 ? 'capture' : 'captures'} in the last 24 hours, already sorted. Open anything to decide what to do with it.`
            : overview.isError
              ? 'Could not load your captures. Check your connection.'
              : ' '}
        </p>
      </header>
      {data && (
        <div className="sections">
          {CATEGORIES.map((c) => (
            <section key={c} className="section" data-cat={c} aria-labelledby={`sec-${c}`}>
              <header className="section-header">
                <span className="cat-dot" aria-hidden="true" />
                <h2 id={`sec-${c}`}>{CATEGORY_LABELS[c]}</h2>
                <span className="mono section-count">{data.counts[c]}</span>
                <span className="section-hint">{CATEGORY_HINTS[c]}</span>
              </header>
              <div className="cards">
                {data.sections[c].length === 0 && <p className="empty card-empty">Nothing here yet.</p>}
                {data.sections[c].map((capture) => (
                  <Card key={capture.id} capture={capture} onOpen={onOpen} />
                ))}
              </div>
              {data.counts[c] > data.sections[c].length && (
                <button type="button" className="link-btn show-all" onClick={() => navigate(href({ view: c }))}>
                  Show all {data.counts[c]} <ArrowRight size={14} aria-hidden="true" />
                </button>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function ListView({
  title,
  subtitle,
  status,
  category,
  q,
  onOpen,
}: {
  title: string;
  subtitle?: string;
  status: CaptureStatus | 'all';
  category?: Category;
  q?: string;
  onOpen: (id: string) => void;
}) {
  const pages = useCapturePages(status, category ?? 'all', q);
  const items = pages.data?.pages.flatMap((p) => p.captures) ?? [];
  return (
    <>
      <header className="desk-hello">
        <button type="button" className="link-btn" onClick={() => navigate('/')}>
          ← Everything
        </button>
        <h1 className="list-title" data-cat={category}>
          {category && <span className="cat-dot" aria-hidden="true" />}
          {title}
        </h1>
        {subtitle && <p className="lead">{subtitle}</p>}
      </header>
      {pages.isError && <p className="empty">Could not load these captures.</p>}
      {pages.isSuccess && items.length === 0 && <p className="empty">Nothing here.</p>}
      <div className="cards cards-grid">
        {items.map((c) => (
          <Card key={c.id} capture={c} onOpen={onOpen} showCategory={!category} />
        ))}
      </div>
      {pages.hasNextPage && (
        <button type="button" className="btn" style={{ marginTop: 16 }} onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
          {pages.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </button>
      )}
    </>
  );
}

function cardMeta(c: Capture): string {
  const origin =
    c.kind === 'voice' ? `Voice${c.durationMs ? ` · ${formatDuration(c.durationMs)}` : ''}` : c.kind === 'link' && c.url ? `Link · ${hostOf(c.url)}` : 'Note';
  // Search mixes statuses: say when a result is no longer open.
  return c.status === 'open' ? origin : `${origin} · ${c.status === 'done' ? 'Done' : 'Archived'}`;
}

function Card({ capture: c, onOpen, showCategory = false }: { capture: Capture; onOpen: (id: string) => void; showCategory?: boolean }) {
  // Until a capture is sorted its title is its own first line; repeating it as the preview is noise.
  const titleStem = (c.title ?? '').replace(/…$/, '');
  const showPreview = Boolean(c.text) && !(titleStem && c.text.startsWith(titleStem) && c.text.length <= titleStem.length + 40);
  return (
    <button type="button" className="card" data-cat={c.category} onClick={() => onOpen(c.id)}>
      <span className="card-title">
        {showCategory && <span className="cat-dot" aria-hidden="true" />}
        {c.title ?? 'Untitled capture'}
      </span>
      {showPreview && <span className="card-preview">{c.text}</span>}
      <span className="card-meta mono">
        <span className="grow">{cardMeta(c)}</span>
        <span>{relativeTime(c.createdAt)}</span>
      </span>
    </button>
  );
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(value.trim());
      }}
    >
      <Search size={16} aria-hidden="true" />
      <label htmlFor="search" className="sr-only">
        Search captures
      </label>
      <input id="search" type="search" placeholder="Search" value={value} onChange={(e) => setValue(e.target.value)} />
      {value && (
        <button type="button" className="search-clear" aria-label="Clear search" onClick={() => onSearch('')}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </form>
  );
}

type BarStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; capture: Capture }
  | { kind: 'queued'; message: string }
  | { kind: 'refused'; message: string; text: string; clientId: string; restored: boolean }
  | { kind: 'store-failed' };

/** Desktop quick capture. A pasted URL becomes a link capture; anything else is a note. */
function CaptureBar() {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  // Latest field content, readable after an await (the submit closure holds a stale copy).
  const valueRef = useRef('');
  valueRef.current = value;
  // A refused text still waiting for the field to be free.
  const pendingRefusal = useRef<Extract<BarStatus, { kind: 'refused' }> | null>(null);
  const [status, setStatus] = useState<BarStatus>({ kind: 'idle' });
  const timer = useRef<number>(undefined);
  // Same guard as the compose sheet: a second Enter before the outbox write finishes would
  // still see the old text and queue a duplicate.
  const enqueuing = useRef(false);
  // The capture the status line is about; a newer capture takes over the line.
  const followed = useRef<string | null>(null);

  const showSaved = (capture: Capture) => {
    window.clearTimeout(timer.current);
    setStatus({ kind: 'saved', capture });
    void queryClient.invalidateQueries({ queryKey: ['captures'] });
    timer.current = window.setTimeout(() => setStatus({ kind: 'idle' }), 4000);
  };
  const showSavedRef = useRef(showSaved);
  showSavedRef.current = showSaved;

  // "Not saved yet" must turn into "Saved" when the retry loop sends it in the background.
  useEffect(
    () =>
      onSent((clientId, capture) => {
        if (followed.current === clientId) showSavedRef.current(capture);
      }),
    [],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = value.trim();
    if (!text || enqueuing.current) return;
    enqueuing.current = true;
    // A lone URL (even without https://) is a link; text with a URL inside is a link with a note.
    const bare = /\s/.test(text) ? null : normalizeUrl(text);
    const url = bare ?? extractUrl(text);
    let item: OutboxItem;
    try {
      item = await enqueue(url ? { kind: 'link', text: bare ? '' : text, url } : { kind: 'text', text });
    } catch {
      // Nothing was stored: the text stays in the field so it can be retried or copied.
      setStatus({ kind: 'store-failed' });
      return;
    } finally {
      enqueuing.current = false;
    }
    // Stored on the device: only now clear the field, unless something new was typed meanwhile.
    // A refused text waiting for a free field takes the freed place, so it never ends up out
    // of reach once its status line is replaced by this new capture's.
    const waiting = pendingRefusal.current;
    if (waiting && valueRef.current.trim() === text) {
      pendingRefusal.current = null;
      setValue(waiting.text);
      await discard(waiting.clientId).catch(() => undefined);
    } else {
      setValue((current) => (current.trim() === text ? '' : current));
    }
    followed.current = item.clientId;
    setStatus({ kind: 'saving' });
    const result = await send(item);
    if (followed.current !== item.clientId) return;
    if (result.ok) {
      showSaved(result.capture);
    } else if (result.retryable) {
      window.clearTimeout(timer.current);
      setStatus({ kind: 'queued', message: `${result.message} Kept on this device, it is sent again automatically.` });
    } else {
      // The server refused the content itself, so nothing exists on the server and retrying
      // as is cannot work. Desktop has no outbox screen, so the text goes back to the field to
      // be fixed. If a newer draft is already there, nothing is overwritten or dropped: the
      // refused text stays in the outbox until "Put it back" is used on an empty field.
      window.clearTimeout(timer.current);
      const fieldFree = !valueRef.current.trim();
      if (fieldFree) {
        setValue(text);
        await discard(item.clientId).catch(() => undefined);
      }
      const refused = { kind: 'refused' as const, message: result.message, text, clientId: item.clientId, restored: fieldFree };
      pendingRefusal.current = fieldFree ? null : refused;
      setStatus(refused);
    }
  }

  async function putBack(refused: Extract<BarStatus, { kind: 'refused' }>) {
    if (valueRef.current.trim()) return;
    pendingRefusal.current = null;
    setValue(refused.text);
    await discard(refused.clientId).catch(() => undefined);
    setStatus({ ...refused, restored: true });
  }

  return (
    <div className="capture-bar-wrap">
      <form className="capture-bar" onSubmit={submit}>
        <label htmlFor="quick-capture" className="sr-only">
          Quick capture
        </label>
        {/* A textarea, not an input: pasted notes keep their line breaks. Enter sends,
            Shift+Enter adds a line, and Enter while an IME is composing is left alone. */}
        <textarea
          id="quick-capture"
          rows={1}
          placeholder="Type a thought or paste a link. It sorts itself."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!value.trim() || status.kind === 'saving'}>
          Capture
        </button>
      </form>
      <p className="capture-bar-status" role="status" aria-live="polite">
        {status.kind === 'saving' && 'Saving…'}
        {status.kind === 'saved' && (
          <>
            Saved to{' '}
            <span data-cat={status.capture.category} className="inline-cat">
              <span className="cat-dot" aria-hidden="true" /> {CATEGORY_LABELS[status.capture.category]}
            </span>
          </>
        )}
        {status.kind === 'queued' && <span className="field-error">Not saved yet. {status.message}</span>}
        {status.kind === 'refused' && status.restored && (
          <span className="field-error">Not saved. {status.message} Your text is back in the field: fix it and press Enter.</span>
        )}
        {status.kind === 'refused' && !status.restored && (
          <span className="field-error">
            Not saved. {status.message} The refused text is kept.{' '}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void putBack(status)}
              disabled={Boolean(value.trim())}
              title={value.trim() ? 'Send or clear the current text first' : undefined}
            >
              Put it back
            </button>
            {value.trim() && ' Send or clear the current text first.'}
          </span>
        )}
        {status.kind === 'store-failed' && (
          <span className="field-error">This device could not store it, so nothing was saved. Your text is still in the field.</span>
        )}
      </p>
    </div>
  );
}
