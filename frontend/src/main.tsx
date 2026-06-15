import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import App from './App';
import { ThemeProvider } from './components/theme/ThemeProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useMarketingAuthStore } from './store/marketingAuthStore';
import { usePlatformAuthStore } from './store/platformAuthStore';
import './i18n/config';
import './index.css';

// Brand the tab from the build env; index.html ships a neutral default.
const appTitle = import.meta.env.VITE_APP_TITLE;
if (appTitle) document.title = appTitle;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
  // Global query-error surface — the inline isError states on individual
  // pages stay; this catches everything else. 401s are swallowed because the
  // api interceptor already handles them (refresh / logout-redirect), and a
  // toast there would just be noise during the bounce to login.
  queryCache: new QueryCache({
    onError: (error: any) => {
      if (error?.response?.status === 401) return;
      toast.error(
        error?.response?.data?.message ?? error?.message ?? 'Something went wrong loading data',
      );
    },
  }),
});

// Cross-tenant cache reset: whenever the *authenticated* state of either realm
// flips — login OR any logout path (header logout, platform logout, the
// 401-interceptor logout) — wipe the React Query cache so a previous user's /
// operator's data can never bleed into the next session. We compare prev vs
// next so token-refresh writes (which leave isAuthenticated untouched) don't
// needlessly clear the cache.
function wireCacheReset<S>(
  subscribe: (listener: (state: S, prev: S) => void) => () => void,
  getAuthed: (state: S) => boolean,
): void {
  subscribe((state, prev) => {
    if (getAuthed(state) !== getAuthed(prev)) {
      queryClient.clear();
    }
  });
}
wireCacheReset(useMarketingAuthStore.subscribe, (s) => s.isAuthenticated);
wireCacheReset(usePlatformAuthStore.subscribe, (s) => s.isAuthenticated);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          {/* Top-level boundary catches render errors anywhere in the app
              (incl. the standalone platform/login routes that sit outside
              MarketingLayout's per-route boundary; the two compose). */}
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
          <Toaster position="top-right" richColors />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
