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

/**
 * Drops sentence punctuation glued after a URL. A closing parenthesis is kept when the URL
 * opened it itself (https://en.wikipedia.org/wiki/Map_(disambiguation)).
 */
export function trimUrlToken(raw: string): string {
  let token = raw;
  for (;;) {
    if (/[.,;:!?»]$/.test(token)) {
      token = token.slice(0, -1);
      continue;
    }
    if (token.endsWith(')') && (token.match(/\(/g)?.length ?? 0) < (token.match(/\)/g)?.length ?? 0)) {
      token = token.slice(0, -1);
      continue;
    }
    return token;
  }
}

/** First http(s) URL inside free text (LinkedIn and Chrome shares mix text and URL). */
export function extractUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text);
  if (!match) return null;
  return normalizeUrl(trimUrlToken(match[0]));
}

/**
 * Removes the one URL that became the capture's link (with the punctuation glued to it),
 * leaving any other URL in the note untouched: the note must not lose content.
 */
export function removeLinkFromNote(text: string, url: string): string {
  const pattern = new RegExp(URL_PATTERN.source, 'gi');
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (normalizeUrl(trimUrlToken(match[0])) !== url) continue;
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    return `${before}${after}`.replace(/[ \t]{2,}/g, ' ').trim();
  }
  return text;
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
