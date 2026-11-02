import { useRef, useState, type FormEvent } from 'react';
import { normalizeUrl } from '../../shared/text';
import { Sheet } from './Sheet';

export interface ComposeValue {
  text: string;
  url?: string;
}

export function ComposeSheet({
  kind,
  initial,
  onSubmit,
  onClose,
}: {
  kind: 'text' | 'link';
  initial?: ComposeValue;
  /** Rejects only when the capture could not be stored on the device: nothing was saved. */
  onSubmit: (value: ComposeValue) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial?.text ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [touched, setTouched] = useState(false);
  // One sheet, one capture. The ref blocks a second tap fired before React re-renders
  // (the sheet stays open until the outbox write finishes); the state disables the button.
  const submittedRef = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  const [storeError, setStoreError] = useState(false);

  const normalized = kind === 'link' ? normalizeUrl(url) : null;
  const canSave = kind === 'link' ? Boolean(normalized) : text.trim().length > 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!canSave || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    setStoreError(false);
    onSubmit(kind === 'link' ? { text: text.trim(), url: normalized! } : { text: text.trim() }).catch(() => {
      // The device refused the write (storage full or blocked): nothing exists anywhere yet,
      // so a new attempt cannot duplicate. Unlock and keep what was typed.
      submittedRef.current = false;
      setSubmitted(false);
      setStoreError(true);
    });
  }

  return (
    <Sheet title={kind === 'link' ? 'Save a link' : 'Write it down'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {kind === 'link' ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <div className="field">
              <label htmlFor="compose-url">Link</label>
              <input
                id="compose-url"
                className="input"
                type="url"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                placeholder="https://"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => setTouched(true)}
                aria-invalid={touched && url !== '' && !normalized}
                aria-describedby="compose-url-error"
                autoFocus
              />
              {touched && url !== '' && !normalized && (
                <span id="compose-url-error" className="field-error">
                  That does not look like a web link.
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor="compose-note">Note (optional)</label>
              <textarea
                id="compose-note"
                className="textarea"
                style={{ minHeight: 88 }}
                placeholder="Why it matters"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="compose-text" className="sr-only">
              Note
            </label>
            <textarea
              id="compose-text"
              className="textarea"
              placeholder="A thought, a task, anything"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          </div>
        )}
        {storeError && (
          <p className="field-error" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
            This device could not store it, so nothing was saved. Your text is still here: try again, or copy it.
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSave || submitted}>
            Save
          </button>
        </div>
      </form>
    </Sheet>
  );
}
