import { ArrowLeft, Archive, Check, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../shared/categories';
import type { Capture, CaptureStatus } from '../../shared/types';
import { CaptureView } from '../components/CaptureView';
import { navigate, useSearchParam } from '../lib/router';
import { relativeTime } from '../lib/time';
import { useCapture, useCapturePages, useUpdateCapture } from '../lib/useCaptures';
import { TopBar } from './CaptureHome';

const KIND_LABEL = { voice: 'Voice', text: 'Note', link: 'Link' } as const;

export function History() {
  const selectedId = useSearchParam('id');
  if (selectedId) return <DetailLoader id={selectedId} />;
  return <HistoryList />;
}

function HistoryList() {
  const [status, setStatus] = useState<CaptureStatus>('open');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const pages = useCapturePages(status, category);
  const visible = pages.data?.pages.flatMap((p) => p.captures) ?? [];

  return (
    <main className="screen">
      <TopBar />
      <h1 style={{ fontSize: 24, letterSpacing: '-0.02em', margin: '16px 0 12px' }}>History</h1>

      <div className="filters" role="group" aria-label="Category filter">
        <button type="button" className="cat-option" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
          All
        </button>
        {CATEGORIES.map((c) => (
          <button key={c} type="button" className="cat-option" data-cat={c} aria-pressed={category === c} onClick={() => setCategory(c)}>
            <span className="cat-dot" aria-hidden="true" />
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      <div className="filters" role="group" aria-label="Status filter" style={{ paddingTop: 0 }}>
        {(['open', 'done', 'archived'] as const).map((s) => (
          <button key={s} type="button" className="cat-option" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === 'open' ? 'Open' : s === 'done' ? 'Done' : 'Archived'}
          </button>
        ))}
      </div>

      <div className="list">
        {pages.isError && <p className="empty">Could not load your captures. Check your connection.</p>}
        {pages.isSuccess && visible.length === 0 && <p className="empty">Nothing here.</p>}
        {visible.map((c) => (
          <button key={c.id} type="button" className="list-item" data-cat={c.category} onClick={() => navigate(`/history?id=${c.id}`)}>
            <span className="cat-dot" aria-hidden="true" />
            <span className="grow">{c.title ?? c.text}</span>
            <span className="meta">
              {KIND_LABEL[c.kind]} · {relativeTime(c.createdAt)}
            </span>
          </button>
        ))}
      </div>
      {pages.hasNextPage && (
        <button
          type="button"
          className="btn btn-block"
          style={{ marginTop: 12 }}
          onClick={() => void pages.fetchNextPage()}
          disabled={pages.isFetchingNextPage}
        >
          {pages.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </button>
      )}
    </main>
  );
}

function DetailLoader({ id }: { id: string }) {
  const capture = useCapture(id);
  if (capture.isPending) return null;
  if (!capture.data) {
    return (
      <main className="screen">
        <TopBar />
        <p className="empty">This capture could not be found.</p>
      </main>
    );
  }
  return <Detail capture={capture.data} />;
}

function Detail({ capture }: { capture: Capture }) {
  const update = useUpdateCapture();
  const setStatus = (status: CaptureStatus) => update.mutate({ id: capture.id, patch: { status } });

  return (
    <main className="screen">
      <header className="topbar">
        <button type="button" className="pill-btn" onClick={() => (window.history.length > 1 ? window.history.back() : navigate('/history'))}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </button>
        <span className="mono">
          {KIND_LABEL[capture.kind]} · {relativeTime(capture.createdAt)}
        </span>
      </header>
      <CaptureView key={capture.id} capture={capture} onChange={() => undefined} />
      <div className="bottom-bar">
        {capture.status === 'open' ? (
          <>
            <button type="button" className="btn btn-primary" onClick={() => setStatus('done')} disabled={update.isPending}>
              <Check size={18} aria-hidden="true" /> Mark done
            </button>
            <button type="button" className="btn" onClick={() => setStatus('archived')} disabled={update.isPending}>
              <Archive size={18} aria-hidden="true" /> Archive
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setStatus('open')} disabled={update.isPending}>
            <RotateCcw size={18} aria-hidden="true" /> Reopen
          </button>
        )}
      </div>
    </main>
  );
}
