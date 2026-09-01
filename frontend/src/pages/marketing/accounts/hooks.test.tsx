import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useConnections, connectionsKey } from './hooks';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn() },
}));

const get = vi.mocked(marketingApi.get);

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ data: { providers: [] } } as never);
});

/**
 * `GET marketing/connections` is `@MarketingRoles('MANAGER')`, and main.tsx
 * toasts every non-401 query error that is not `meta.silent`. Both halves of
 * that sentence are pinned here: a caller on a mixed-role screen has to be able
 * to withhold the request, and when it does fail it must not shout over the
 * caller's own inline story.
 */
describe('useConnections', () => {
  it('fires by default — AccountCenterPage only ever renders behind the manager route', async () => {
    const qc = client();
    renderHook(() => useConnections(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/connections'));
  });

  it('issues nothing at all when the caller disables it (a rep on the Studio)', async () => {
    const qc = client();
    const { result } = renderHook(() => useConnections({ enabled: false }), { wrapper: wrapper(qc) });

    expect(get).not.toHaveBeenCalled();
    // …and the panel that reads `isLoading` must not be left spinning forever.
    expect(result.current.isLoading).toBe(false);
  });

  it('opts out of the global error toast, because both callers render their own failure state', async () => {
    const qc = client();
    renderHook(() => useConnections(), { wrapper: wrapper(qc) });

    await waitFor(() =>
      expect(qc.getQueryCache().find({ queryKey: connectionsKey })?.meta).toEqual({ silent: true }),
    );
  });
});
