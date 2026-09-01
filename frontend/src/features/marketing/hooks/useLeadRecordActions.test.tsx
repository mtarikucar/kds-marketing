import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useLeadRecordInvalidate,
  useLeadOfferActions,
  useLeadTaskActions,
} from './useLeadRecordActions';
import * as leadsService from '../api/leads.service';

vi.mock('../api/leads.service', () => ({
  createOffer: vi.fn(),
  sendOffer: vi.fn(),
  deleteOffer: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  deleteTask: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * The invalidation SET, asserted directly.
 *
 * `useLeadRecordActions` exists so the record card and the lead detail page
 * cannot drift on the part nobody looks at — which is exactly this list. The
 * file already says in prose that a new consumer must add its key here, and
 * prose is not a test: dropping a key from the set breaks nothing visible in
 * any component test, because every one of them mounts the surface whose key
 * is still listed.
 *
 * So this counts the keys, by name, on a real QueryClient. `['marketing','lead',
 * id]` is the person's own record; `['marketing','leads']` is the people list
 * and its counts; `['marketing','dashboard']` is the home panel; and
 * `['marketing','tasks']` is the surface's Görevler and Takvim views, which
 * read the workspace task endpoints under a key none of the other three
 * prefix-matches. Without the fourth, completing a task on the record card
 * leaves the person's row in the left column showing the task they just closed.
 */
function harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const keys = () =>
    invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
  return { qc, invalidate, wrapper, keys };
}

const EXPECTED = [
  ['marketing', 'lead', 'p1'],
  ['marketing', 'leads'],
  ['marketing', 'dashboard'],
  ['marketing', 'tasks'],
].map((k) => JSON.stringify(k));

describe('useLeadRecordInvalidate — everything a write to one person can make wrong', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the person, the list, the dashboard AND the task views', () => {
    const { wrapper, keys } = harness();
    const { result } = renderHook(() => useLeadRecordInvalidate('p1'), { wrapper });

    result.current();

    // A SET, not a prefix: none of the first three prefix-matches
    // ['marketing','tasks'], which is the whole reason the fourth had to be
    // named rather than assumed.
    expect(keys()).toEqual(EXPECTED);
  });
});

describe('the six writes all run the same set', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a completed task refreshes the task views, not just the person', async () => {
    vi.mocked(leadsService.completeTask).mockResolvedValue(undefined);
    const { wrapper, keys } = harness();
    const { result } = renderHook(() => useLeadTaskActions('p1'), { wrapper });

    result.current.complete.mutate('t1');

    await waitFor(() => expect(result.current.complete.isSuccess).toBe(true));
    expect(keys()).toEqual(EXPECTED);
  });

  it('a created offer runs the same set — one list, six writes', async () => {
    vi.mocked(leadsService.createOffer).mockResolvedValue(undefined);
    const { wrapper, keys } = harness();
    const { result } = renderHook(() => useLeadOfferActions('p1'), { wrapper });

    result.current.create.mutate({});

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    expect(keys()).toEqual(EXPECTED);
  });
});
