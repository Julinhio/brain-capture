import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useDeleteCapture } from '../lib/useCaptures';

/**
 * Discreet on purpose: a first press only asks, the second deletes for good. The capture goes
 * with its project links and its calendar suggestion; an event already in Google stays there.
 */
export function DeleteCapture({ id, onDeleted, disabled }: { id: string; onDeleted: () => void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  const remove = useDeleteCapture(onDeleted);
  if (!asking) {
    return (
      <button type="button" className="btn btn-ghost btn-delete" onClick={() => setAsking(true)} disabled={disabled}>
        <Trash2 size={16} aria-hidden="true" /> Delete
      </button>
    );
  }
  return (
    <span className="delete-confirm" role="group" aria-label="Confirm deletion">
      <span className="delete-question">{remove.isError ? `Not deleted. ${remove.error.message}` : 'Delete for good?'}</span>
      <button type="button" className="btn btn-sm btn-danger" onClick={() => remove.mutate(id)} disabled={remove.isPending}>
        {remove.isPending ? 'Deleting…' : 'Delete'}
      </button>
      {/* The safe choice has the focus: a stray Enter cancels. */}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsking(false)} disabled={remove.isPending} autoFocus>
        Cancel
      </button>
    </span>
  );
}
