import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { SharedData } from '../shared/share';
import { api, onUnauthorized, RequestError } from './lib/api';
import { startAutoFlush } from './lib/outbox';
import { usePath, useSearchParam } from './lib/router';
import { DESKTOP_QUERY, useMediaQuery } from './lib/useMediaQuery';
import { CaptureHome } from './screens/CaptureHome';
import { Dashboard } from './screens/Dashboard';
import { History } from './screens/History';
import { Login } from './screens/Login';

function readShare(): SharedData {
  const params = new URLSearchParams(window.location.search);
  return { title: params.get('title'), text: params.get('text'), url: params.get('url') };
}

export function App() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: Infinity });
  const path = usePath();
  const view = useSearchParam('view');
  const desktop = useMediaQuery(DESKTOP_QUERY);
  // Opening the app with no network must still allow a capture: only a real 401 means
  // "signed out", a failed request keeps the capture screen and queues locally.
  const offline = me.error instanceof RequestError && me.error.code === 'network';
  const signedIn = Boolean(me.data) || offline;

  useEffect(
    () =>
      onUnauthorized(() => {
        queryClient.setQueryData(['me'], null);
        queryClient.removeQueries({ queryKey: ['captures'] });
        queryClient.removeQueries({ queryKey: ['capture'] });
        queryClient.removeQueries({ queryKey: ['projects'] });
        queryClient.removeQueries({ queryKey: ['calendar'] });
        queryClient.removeQueries({ queryKey: ['radars'] });
        queryClient.removeQueries({ queryKey: ['categories'] });
        queryClient.removeQueries({ queryKey: ['capture-event'] });
        queryClient.removeQueries({ queryKey: ['capture-removed'] });
      }),
    [queryClient],
  );

  // Re-runs on every sign-in, so captures queued while signed out leave right after.
  useEffect(() => {
    if (!signedIn) return;
    return startAutoFlush();
  }, [signedIn]);

  if (me.isPending) return null;
  if (!signedIn) return <Login />;
  // /share hands over to /capture (same element, so the screen state carries over), which shows
  // the capture flow on every device, desktop included.
  if (path === '/share' || path === '/capture') return <CaptureHome share={path === '/share' ? readShare() : undefined} />;
  if (path === '/' && (desktop || Boolean(view))) return <Dashboard />;
  if (path.startsWith('/history')) return <History />;
  return <CaptureHome />;
}
