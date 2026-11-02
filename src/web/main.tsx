import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // React Query pauses requests while the browser reports offline; the app must instead
      // try, fail fast and fall back (the capture screen works offline through the outbox).
      networkMode: 'always',
      staleTime: 15_000,
      // Captures made on the phone show up on the desktop when the tab regains focus.
      refetchOnWindowFocus: true,
      retry: 1,
    },
    mutations: { networkMode: 'always' },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
