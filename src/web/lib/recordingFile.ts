import type { OutboxItem } from './outbox';

type VoiceItem = Extract<OutboxItem, { kind: 'voice' }>;

/** e.g. brain-capture-2026-11-02-21-13-05.webm, matching the container the phone recorded. */
export function recordingFile(item: VoiceItem): File {
  const type = item.audio.type || item.mimeType;
  const ext = type.includes('mp4') || type.includes('aac') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  const stamp = new Date(item.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new File([item.audio], `brain-capture-${stamp}.${ext}`, { type });
}

/**
 * Copies the recording out of the app (Downloads folder), so it no longer depends on the
 * browser's storage. The outbox keeps its own copy: nothing is moved or deleted here.
 */
export function downloadRecording(item: VoiceItem): void {
  const file = recordingFile(item);
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  // Long enough for the download to start on a slow phone.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareRecording(item: VoiceItem): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [recordingFile(item)] });
  } catch {
    return false;
  }
}

/** Opens the system share sheet (Drive, Gmail…) with the audio file. */
export async function shareRecording(item: VoiceItem): Promise<void> {
  const file = recordingFile(item);
  await navigator.share({ files: [file], title: file.name });
}
