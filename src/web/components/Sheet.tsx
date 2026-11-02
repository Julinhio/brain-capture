import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Bottom sheet. Enters with @starting-style (CSS, off the main thread); closing is instant
 * because it always follows a decision (save, cancel) and the next view takes over.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = original;
      previous?.focus?.();
    };
  }, []);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="sheet-handle" aria-hidden="true" />
        <h2>{title}</h2>
        {children}
      </div>
    </>
  );
}
