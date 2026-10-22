import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { PROVIDER_FUTURE, ROUTER_FUTURE, routes } from './App';
import { isApiError, setUnauthorizedHandler } from './api/client';
import i18n from './i18n/config';
import { startTheme } from './lib/theme';
import './index.css';

startTheme();
document.title = i18n.t('app.name');

const router = createBrowserRouter(routes, { future: ROUTER_FUTURE });

// A 401 sends the browser to the right sign-in page, remembering where it was so signing in
// comes back there (router state, never the URL, so it cannot point off-site).
setUnauthorizedHandler((target) => {
  const { pathname, search } = router.state.location;
  if (pathname === target) return;
  void router.navigate(target, { replace: true, state: { from: `${pathname}${search}` } });
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx will not change by asking again; network and server errors get two more tries.
      retry: (failures, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && failures < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} future={PROVIDER_FUTURE} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
