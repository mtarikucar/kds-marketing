import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useConnections, connectionsKey, mailboxOf } from './hooks';

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

/**
 * The mailbox block AccountCenterService attaches to an EMAIL source. It is
 * read through a helper rather than off the type, so the shape is asserted in
 * exactly one place — see `mailboxOf`'s comment.
 */
describe('mailboxOf', () => {
  it('reads the block off an email source', () => {
    expect(
      mailboxOf({
        capability: 'INBOX',
        model: 'Channel',
        id: 'ch1',
        status: 'ACTIVE',
        mailbox: { consent: true, reauthRequired: true, address: 'destek@acme.com' },
      } as never),
    ).toEqual({ consent: true, reauthRequired: true, address: 'destek@acme.com' });
  });

  it('answers null for every other capability, and for a server that has not shipped it', async () => {
    // The page branches on this, so a non-email source must never look like a
    // mailbox — and a deploy whose backend predates the field must render the
    // old way rather than an Edit button that patches nothing.
    expect(mailboxOf({ capability: 'PUBLISH', model: 'SocialAccount', id: 'sa1', status: 'ACTIVE' })).toBeNull();
    expect(mailboxOf({ capability: 'INBOX', model: 'Channel', id: 'ch1', status: 'ACTIVE' })).toBeNull();
  });
});
