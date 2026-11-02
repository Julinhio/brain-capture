import { useSyncExternalStore } from 'react';

// Three screens do not justify a router dependency: pushState plus a subscription is enough.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  for (const l of listeners) l();
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useSearchParam(name: string): string | null {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  return new URLSearchParams(search).get(name);
}
