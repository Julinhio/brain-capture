import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CATEGORY_LABELS } from '../../shared/categories';
import { hostOf } from '../../shared/text';
import type { Capture } from '../../shared/types';
import { useUpdateCapture } from '../lib/useCaptures';
import { CategoryOptions } from './CategoryPicker';
import { CategoryIcon } from './CategoryIcon';

const SOURCE_LABEL = { voice: 'Transcription', text: 'Note', link: 'Note' } as const;

function categoryHint(c: Capture): string {
  if (c.categorySource === 'manual') return 'Moved by you. Tap to change.';
  if (c.classificationStatus === 'done') return 'Sorted automatically. Tap to move it.';
  if (c.classificationStatus === 'pending') return 'Sorting… it lands in Other until then.';
  return 'Could not sort it automatically yet. Tap to choose.';
}

/** Shared by the "Saved" confirmation and the capture detail. */
export function CaptureView({
  capture,
  header,
  onChange,
  inlineCategories = false,
}: {
  capture: Capture;
  header?: ReactNode;
  onChange: (capture: Capture) => void;
  /** Desktop drawer: all categories visible at once instead of behind a "Change" chip. */
  inlineCategories?: boolean;
}) {
  const update = useUpdateCapture(onChange);
  const [pickingCategory, setPickingCategory] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [draft, setDraft] = useState(capture.text);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(capture.title ?? '');

  const edited = capture.text !== capture.originalText;

  return (
    <div>
      {header}
      {editingTitle ? (
        <form
          className="block"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!titleDraft.trim()) return;
            update.mutate({ id: capture.id, patch: { title: titleDraft.trim() } }, { onSuccess: () => setEditingTitle(false) });
          }}
        >
          <label htmlFor="title-input" className="sr-only">
            Title
          </label>
          <input
            id="title-input"
            className="input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            maxLength={200}
            autoFocus
          />
          <div className="sheet-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditingTitle(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!titleDraft.trim() || update.isPending}>
              Save title
            </button>
          </div>
        </form>
      ) : (
        <h1 className="capture-title">
          <button
            type="button"
            onClick={() => {
              setTitleDraft(capture.title ?? '');
              setEditingTitle(true);
            }}
            style={{ all: 'inherit', cursor: 'text' }}
            aria-label={`Title: ${capture.title ?? 'Untitled'}. Tap to rename.`}
          >
            {capture.title ?? 'Untitled capture'}
          </button>
        </h1>
      )}

      <section className="block" aria-labelledby="category-label">
        <div className="block-head">
          <span id="category-label" className="mono">
            Category
          </span>
        </div>
        {pickingCategory || inlineCategories ? (
          <CategoryOptions
            value={capture.category}
            onChange={(category) => {
              setPickingCategory(false);
              if (category !== capture.category || capture.categorySource !== 'manual') {
                update.mutate({ id: capture.id, patch: { category } });
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="cat-chip"
            data-cat={capture.category}
            onClick={() => setPickingCategory(true)}
            aria-expanded={false}
          >
            <CategoryIcon category={capture.category} />
            {CATEGORY_LABELS[capture.category]}
            <span className="change">
              Change <ChevronDown size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} />
            </span>
          </button>
        )}
        <p className="hint">{categoryHint(capture)}</p>
      </section>

      {capture.url && (
        <section className="block" aria-label="Source">
          <div className="block-head">
            <span className="mono">Source</span>
          </div>
          <a className="source-card" href={capture.url} target="_blank" rel="noopener noreferrer">
            <span className="grow">
              <span className="host">{hostOf(capture.url)}</span>
              <span className="full" style={{ display: 'block' }}>
                {capture.url}
              </span>
            </span>
            <ArrowUpRight size={18} aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </section>
      )}

      <section className="block" aria-labelledby="text-label">
        <div className="block-head">
          <span id="text-label" className="mono">
            {SOURCE_LABEL[capture.kind]}
          </span>
          {!editingText && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraft(capture.text);
                setEditingText(true);
              }}
            >
              Edit
            </button>
          )}
        </div>
        {editingText ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ id: capture.id, patch: { text: draft } }, { onSuccess: () => setEditingText(false) });
            }}
          >
            <label htmlFor="text-edit" className="sr-only">
              Edit text
            </label>
            <textarea id="text-edit" className="textarea" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <div className="sheet-actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditingText(false)}>
                Cancel
              </button>
              {edited && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(capture.originalText)}>
                  Restore original
                </button>
              )}
              <button type="submit" className="btn btn-sm btn-primary" disabled={update.isPending}>
                Save
              </button>
            </div>
          </form>
        ) : capture.text ? (
          <p className="body-text" style={{ margin: 0 }}>
            {capture.text}
          </p>
        ) : (
          <p className="hint" style={{ margin: 0 }}>
            No note.
          </p>
        )}
        {edited && !editingText && <p className="hint">Edited. The original text is kept.</p>}
        {capture.kind === 'voice' && <p className="hint">Audio deleted after transcription. Only the text is kept.</p>}
      </section>

      {update.isError && (
        <p className="field-error" role="alert" style={{ marginTop: 16 }}>
          {update.error.message}
        </p>
      )}
    </div>
  );
}
