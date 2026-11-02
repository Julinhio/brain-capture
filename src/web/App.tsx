import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, RequestError } from './lib/api';
import { startAutoFlush } from './lib/outbox';
import { usePath } from './lib/router';
import { CaptureHome } from './screens/CaptureHome';
import { History } from './screens/History';
import { Login } from './screens/Login';

export function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: Infinity });
  const path = usePath();
  // Opening the app with no network must still allow a capture: only a real 401 means
  // "signed out", a failed request keeps the capture screen and queues locally.
  const offline = me.error instanceof RequestError && me.error.code === 'network';
  const signedIn = Boolean(me.data) || offline;

  useEffect(() => {
    if (!signedIn) return;
    return startAutoFlush();
  }, [signedIn]);

  if (me.isPending) return null;
  if (!signedIn) return <Login />;
  if (path.startsWith('/history')) return <History />;
  return <CaptureHome />;
}
