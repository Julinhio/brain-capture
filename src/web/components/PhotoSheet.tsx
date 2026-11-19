import { Camera, Images } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { preparePhoto, type PreparedPhoto } from '../lib/photo';
import { Sheet } from './Sheet';

/**
 * Take a photo or pick one, optionally add a sentence, send. The sentence is never required: a
 * photo of an apple is enough. The picture is resized here, before it is stored on the device
 * or sent.
 */
export function PhotoSheet({
  onSubmit,
  onClose,
}: {
  /** Rejects only when the photo could not be stored on the device: nothing was saved. */
  onSubmit: (photo: PreparedPhoto, caption: string) => Promise<void>;
  onClose: () => void;
}) {
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittedRef = useRef(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!photo) return;
    const url = URL.createObjectURL(photo.image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // The same file can be picked again after an error.
    e.target.value = '';
    if (!file) return;
    setError(null);
    setPreparing(true);
    try {
      setPhoto(await preparePhoto(file));
    } catch {
      setError('This file could not be read as a photo. Try another one.');
    } finally {
      setPreparing(false);
    }
  }

  function send() {
    if (!photo || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    setError(null);
    onSubmit(photo, caption.trim()).catch(() => {
      submittedRef.current = false;
      setSubmitted(false);
      setError('This device could not store the photo, so nothing was sent. Try again.');
    });
  }

  const pickers = (
    <div className="photo-pickers">
      <label className="btn btn-block">
        <Camera size={18} aria-hidden="true" /> {photo ? 'Retake' : 'Take a photo'}
        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={pick} disabled={preparing || submitted} />
      </label>
      <label className="btn btn-block">
        <Images size={18} aria-hidden="true" /> {photo ? 'Choose another' : 'Choose from gallery'}
        <input type="file" accept="image/*" className="sr-only" onChange={pick} disabled={preparing || submitted} />
      </label>
    </div>
  );

  return (
    <Sheet title="Photo" onClose={onClose}>
      {!photo && <p className="hint photo-lead">A meal, a snack, your scale or a workout summary. It is read and logged for you.</p>}
      {preview && <img className="photo-preview" src={preview} alt="Selected photo" />}
      {preparing && (
        <p className="hint" role="status">
          Preparing the photo…
        </p>
      )}
      {pickers}
      {photo && (
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="photo-caption">Anything to add? (optional)</label>
          <textarea
            id="photo-caption"
            className="textarea"
            style={{ minHeight: 72 }}
            placeholder="I ate half of it"
            value={caption}
            maxLength={1000}
            onChange={(e) => setCaption(e.target.value)}
          />
        </div>
      )}
      {error && (
        <p className="field-error" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          {error}
        </p>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={send} disabled={!photo || preparing || submitted}>
          Send
        </button>
      </div>
    </Sheet>
  );
}
