import { Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useDeleteCapture } from '../lib/useCaptures';

/**
 * The capture's actions followed by a discreet bin. Pressing the bin swaps the whole row for the
 * question, so the confirmation gets the room the other buttons leave: the first press only
 * asks, the second deletes for good. The capture goes with its project links and its calendar
 * suggestion; an event already in Google stays there.
 */
export function DeleteCapture({
  id,
  onDeleted,
  disabled,
  children,
}: {
  id: string;
  onDeleted: () => void;
  disabled?: boolean;
  /** The other actions (Mark done, Archive, Reopen), hidden while the question is asked. */
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const remove = useDeleteCapture(onDeleted);
  if (!asking) {
    return (
      <>
        {children}
        <button
          type="button"
          className="btn btn-ghost btn-delete btn-icon"
          onClick={() => setAsking(true)}
          disabled={disabled}
          aria-label="Delete this capture"
          title="Delete"
        >
          <Trash2 size={18} aria-hidden="true" />
        </button>
      </>
    );
  }
  return (
    <div className="delete-confirm" role="group" aria-label="Confirm deletion">
      <span className="delete-question" role={remove.isError ? 'alert' : undefined}>
        {remove.isError ? `Not deleted. ${remove.error.message}` : 'Delete this capture for good?'}
      </span>
      {/* The safe choice has the focus: a stray Enter cancels. */}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsking(false)} disabled={remove.isPending} autoFocus>
        Cancel
      </button>
      <button type="button" className="btn btn-sm btn-danger" onClick={() => remove.mutate(id)} disabled={remove.isPending}>
        <Trash2 size={16} aria-hidden="true" />
        {remove.isPending ? 'Deleting…' : 'Delete'}
      </button>
    </div>
  );
}
