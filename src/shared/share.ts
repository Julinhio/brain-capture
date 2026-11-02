import { extractUrl, normalizeUrl, removeLinkFromNote } from './text.js';

export interface SharedData {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

export type SharedCapture = { kind: 'link'; url: string; text: string } | { kind: 'text'; text: string };

/**
 * Turns what Android's share sheet hands over into a capture. Apps fill the fields
 * differently: Chrome sends `url` (+ page `title`), LinkedIn and most apps put the link
 * inside `text`. Nothing shared is dropped except the link repeated in the note.
 */
export function sharedToCapture(data: SharedData): SharedCapture | null {
  const title = data.title?.trim() ?? '';
  const text = data.text?.trim() ?? '';
  const url = (data.url && normalizeUrl(data.url)) || extractUrl(text) || extractUrl(title);

  const parts = [title, text].filter(Boolean);
  // Some apps send the same string as title and text.
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  const note = unique.join('\n');

  if (url) return { kind: 'link', url, text: removeLinkFromNote(note, url) };
  if (note) return { kind: 'text', text: note };
  return null;
}
