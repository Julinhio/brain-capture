import { Archive, Check, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Capture } from '../../shared/types';
import { clockTime, formatDuration } from '../lib/time';
import { useCapture, useRemovedCapture, useUpdateCapture } from '../lib/useCaptures';
import { CaptureView } from './CaptureView';
import { DeleteCapture } from './DeleteCapture';

const KIND_HEADER = { voice: 'Voice note', text: 'Note', link: 'Link' } as const;
const DEVICE_LABEL: Record<string, string> = { android: 'from Android', ios: 'from iPhone', desktop: 'from desktop' };

/**
 * Right-hand detail panel. Closing it is not the same as finishing the capture: "Mark done"
 * and "Archive" are explicit, and nothing here is required.
 */
export function Drawer({ id, onClose }: { id: string; onClose: () => void }) {
  const capture = useCapture(id);
  const removed = useRemovedCapture(id);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape inside a text field cancels that edit first; a second Escape closes.
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  return (
    <>
      <div className="scrim drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Capture detail">
        <div className="drawer-head">
          <span className="mono">{capture.data ? headerLine(capture.data) : ''}</span>
          <button ref={closeRef} type="button" className="drawer-close" onClick={onClose} aria-label="Close detail">
            <span className="mono" aria-hidden="true">
              esc
            </span>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="drawer-body">
          {capture.isPending && <p className="hint">Loading…</p>}
          {capture.isError && !removed && <p className="field-error">This capture could not be loaded.</p>}
          {capture.data && <CaptureView key={capture.data.id} capture={capture.data} onChange={() => undefined} inlineCategories />}
        </div>
        {capture.data && !removed && <DrawerActions capture={capture.data} onDeleted={onClose} />}
      </aside>
    </>
  );
}

function headerLine(c: Capture): string {
  const parts: string[] = [KIND_HEADER[c.kind], clockTime(c.createdAt)];
  if (c.durationMs) parts.push(formatDuration(c.durationMs));
  if (c.device && DEVICE_LABEL[c.device]) parts.push(DEVICE_LABEL[c.device]!);
  return parts.join(' · ');
}

function DrawerActions({ capture, onDeleted }: { capture: Capture; onDeleted: () => void }) {
  const update = useUpdateCapture();
  const set = (status: Capture['status']) => update.mutate({ id: capture.id, patch: { status } });
  return (
    <div className="drawer-foot">
      <DeleteCapture id={capture.id} onDeleted={onDeleted} disabled={update.isPending}>
        {capture.status === 'open' ? (
          <>
            <button type="button" className="btn btn-primary" onClick={() => set('done')} disabled={update.isPending}>
              <Check size={18} aria-hidden="true" /> Mark done
            </button>
            <button type="button" className="btn" onClick={() => set('archived')} disabled={update.isPending}>
              <Archive size={18} aria-hidden="true" /> Archive
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => set('open')} disabled={update.isPending}>
            <RotateCcw size={18} aria-hidden="true" /> Reopen
          </button>
        )}
      </DeleteCapture>
      {update.isError && (
        <p className="field-error drawer-note" role="alert">
          Not changed. {update.error.message}
        </p>
      )}
    </div>
  );
}
