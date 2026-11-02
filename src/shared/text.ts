const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/i;

/** Parses an http(s) URL, or returns null. Other schemes are refused so a link card is always safe to open. */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** First http(s) URL inside free text, trailing punctuation removed (LinkedIn and Chrome shares mix text and URL). */
export function extractUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text);
  if (!match) return null;
  return normalizeUrl(match[0].replace(/[).,;:!?»]+$/, ''));
}

/** Removes URLs together with the punctuation glued to them ("Qonto https://x.com/job)." -> "Qonto"). */
export function stripUrls(text: string): string {
  return text
    .replace(/\(?https?:\/\/[^\s<>"'`]+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Readable title used until (or instead of) the AI one. */
export function fallbackTitle(text: string, url: string | null): string {
  const firstLine = text
    .replace(/https?:\/\/\S+/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (firstLine) return firstLine.length > 60 ? `${firstLine.slice(0, 59).trimEnd()}…` : firstLine;
  if (url) return hostOf(url);
  return 'Untitled capture';
}
