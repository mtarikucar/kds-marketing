import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLeadRecord } from './useLeadRecord';
import * as leadsService from '../api/leads.service';

vi.mock('../api/leads.service', () => ({ getLead: vi.fn() }));

/**
 * The retry policy is the ONLY thing this hook adds to `useQuery`, and it is
 * the reason the hook exists at all: the record card and the lead detail page
 * share `['marketing','lead',id]`, React Query keys the CACHE and not the
 * POLICY, and two `useQuery` calls on one key were free to disagree about the
 * options — as they did in the first draft, where the detail page refused to
 * retry a 404 and the card burned three requests on the same deleted lead.
 *
 * That rule had no direct test. Rewriting it to
 * `retry: (failureCount) => failureCount < 2` — the same retry COUNT, but 404s
 * retried, which is precisely the case the hook exists to special-case — passed
 * 137/137. Its only witness was a timing coincidence over in
 * `LeadContextPane.test.tsx`: vitest's 5s per-test cap happened to beat a
 * 1+2+4s backoff, failing at 5040ms against a 5000ms budget — about two seconds
 * from flaking in either direction.
 *
 * So this counts the CALLS. `retryDelay: 0` is a property of the test's client
 * rather than of the policy: it removes the wall-clock dependency without
 * touching the thing under test.
 */
function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: {
      // Deliberately the OPPOSITE default, so any count above one proves the
      // hook's own policy is what ran rather than an inherited one. The delay
      // is zeroed so three attempts do not cost seven seconds.
      queries: { retry: false, retryDelay: 0, gcTime: 0 },
    },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** What the axios interceptor hands React Query: the status lives on `response`. */
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status } });

describe('useLeadRecord — one key, one retry policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks once for a 404 — a deleted lead is the answer, not a blip', async () => {
    vi.mocked(leadsService.getLead).mockRejectedValue(httpError(404));

    const { result } = renderHook(() => useLeadRecord('gone'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(vi.mocked(leadsService.getLead)).toHaveBeenCalledTimes(1);
  });

  it('asks three times for a 500 — one dropped packet is not a failure sentence', async () => {
    vi.mocked(leadsService.getLead).mockRejectedValue(httpError(500));

    const { result } = renderHook(() => useLeadRecord('p1'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // `failureCount < 2`: the first attempt plus two retries, and then it
    // concedes. This is the number the card's five sections wait through.
    expect(vi.mocked(leadsService.getLead)).toHaveBeenCalledTimes(3);
  });

  it('retries a failure that carries no HTTP status at all', async () => {
    // A dropped connection never reaches a status code. Reading `err.response`
    // off it must not be mistaken for "not a 404, so retry" by accident — it
    // must be the rule.
    vi.mocked(leadsService.getLead).mockRejectedValue(new Error('Network Error'));

    const { result } = renderHook(() => useLeadRecord('p1'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(vi.mocked(leadsService.getLead)).toHaveBeenCalledTimes(3);
  });

  it('asks once when the read succeeds, and hands back the record', async () => {
    vi.mocked(leadsService.getLead).mockResolvedValue({
      id: 'p1',
      businessName: 'Acme Kafe',
    } as Awaited<ReturnType<typeof leadsService.getLead>>);

    const { result } = renderHook(() => useLeadRecord('p1'), { wrapper });

    await waitFor(() => expect(result.current.data?.id).toBe('p1'));
    expect(vi.mocked(leadsService.getLead)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(leadsService.getLead)).toHaveBeenCalledWith('p1');
  });
});
