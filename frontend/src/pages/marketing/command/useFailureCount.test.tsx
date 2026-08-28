import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFailureCount } from './useFailureCount';
import { AgentActivity } from './AgentActivity';
import * as commandService from '../../../features/marketing/api/command.service';
import type {
  AgentRun,
  AgentRunToolCall,
} from '../../../features/marketing/api/command.service';

vi.mock('../../../features/marketing/api/command.service');

const listAgentRuns = vi.mocked(commandService.listAgentRuns);

const call = (over: Partial<AgentRunToolCall> = {}): AgentRunToolCall => ({
  id: 'c1',
  tool: 'jeeta.draft_social_post',
  ok: true,
  error: null,
  createdAt: '2026-08-28T09:00:00Z',
  ...over,
});

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'r1',
  agent: 'social',
  goal: 'eylül gönderileri',
  status: 'SUCCEEDED',
  error: null,
  startedAt: '2026-08-28T09:00:00Z',
  finishedAt: '2026-08-28T09:01:00Z',
  toolCalls: [],
  ...over,
});

function renderCount(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...renderHook(() => useFailureCount(), { wrapper }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  listAgentRuns.mockResolvedValue([]);
});

describe('useFailureCount', () => {
  it('is zero while the runs are still loading, rather than guessing', () => {
    const { result } = renderCount();
    expect(result.current).toBe(0);
  });

  it('counts a run whose tool call came back not-ok', async () => {
    listAgentRuns.mockResolvedValue([
      run({ id: 'r1', toolCalls: [call({ id: 'c1', ok: true }), call({ id: 'c2', ok: false })] }),
    ]);
    const { result } = renderCount();
    await waitFor(() => expect(result.current).toBe(1));
  });

  // The badge counts FAILURES, not activity. A badge that lights up because the
  // agent had a productive morning is noise, and noise is how a real failure
  // gets ignored.
  //
  // The one failed run is the CONTROL: it is what makes the expected value
  // non-zero, so the assertion cannot be satisfied by the hook's loading state.
  // Asserting a bare 0 here would pass before the fetch even resolved.
  it('does not count runs that went fine', async () => {
    listAgentRuns.mockResolvedValue([
      run({ id: 'r1', toolCalls: [call({ ok: true })] }),
      run({ id: 'r2', toolCalls: [call({ ok: true }), call({ id: 'c2', ok: true })] }),
      run({ id: 'r3', goal: 'araştırma', toolCalls: [] }),
      run({ id: 'r4', toolCalls: [call({ ok: false })] }),
    ]);
    const { result } = renderCount();
    await waitFor(() => expect(result.current).toBe(1));
  });

  // AgentActivity paints a run red on `status === 'FAILED'` too — a run that
  // died before it got a tool call off is still a failure the owner has not
  // seen. Counting only not-ok tool calls would leave that one silently
  // unbadged while the tab it points at shows it in red.
  it('counts a run that failed outright, not just a failed tool call', async () => {
    listAgentRuns.mockResolvedValue([
      run({ id: 'r1', status: 'FAILED', error: 'AI is not configured', toolCalls: [] }),
    ]);
    const { result } = renderCount();
    await waitFor(() => expect(result.current).toBe(1));
  });

  it('counts each failed run once, however many of its calls failed', async () => {
    listAgentRuns.mockResolvedValue([
      run({
        id: 'r1',
        status: 'FAILED',
        toolCalls: [call({ id: 'c1', ok: false }), call({ id: 'c2', ok: false })],
      }),
      run({ id: 'r2', toolCalls: [call({ ok: true })] }),
    ]);
    const { result } = renderCount();
    await waitFor(() => expect(result.current).toBe(1));
  });

  // A run with no goal and no tool calls is bookkeeping — AgentActivity filters
  // it out and never draws it. Badging one would send the owner to a tab where
  // there is nothing to find.
  it('ignores runs the flow panel would not list at all', async () => {
    listAgentRuns.mockResolvedValue([
      // Bookkeeping: no goal, no calls — AgentActivity's isNewsworthy drops it.
      run({ id: 'r1', goal: null, status: 'FAILED', toolCalls: [] }),
      // Real, and listed. Present so the expected count is 1 rather than 0,
      // which is what stops the loading state from satisfying the assertion.
      run({ id: 'r2', goal: 'eylül gönderileri', status: 'FAILED', toolCalls: [] }),
    ]);
    const { result } = renderCount();
    await waitFor(() => expect(result.current).toBe(1));
  });

  // THE risk in this pair of files. The badge and the flow panel must read one
  // cache entry, or the badge can say 3 while the tab it points at shows none —
  // worse than no badge, because it spends the owner's trust to say nothing.
  // Rendering the real AgentActivity alongside the hook makes that structural:
  // two query keys would mean two cache entries and two fetches.
  it('reads the very cache entry AgentActivity fills, not a parallel one', async () => {
    listAgentRuns.mockResolvedValue([run({ id: 'r1', toolCalls: [call({ ok: false })] })]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <AgentActivity />
        {children}
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useFailureCount(), { wrapper });

    await waitFor(() => expect(result.current).toBe(1));
    expect(qc.getQueryCache().getAll()).toHaveLength(1);
    expect(listAgentRuns).toHaveBeenCalledTimes(1);
  });

  // A failed fetch must not be reported as "nothing failed" — that is the one
  // lie this badge cannot afford. Zero is honest here only because the flow tab
  // itself shows the error the moment it is opened.
  it('reports zero rather than throwing when the runs cannot be fetched', async () => {
    listAgentRuns.mockRejectedValue(new Error('boom'));
    const { result, qc } = renderCount();
    // Waiting on the CACHE, not on the mock being called: the hook reads 0 while
    // loading too, so a call-count wait would pass long before the error landed.
    await waitFor(() =>
      expect(qc.getQueryCache().getAll()[0]?.state.status).toBe('error'),
    );
    expect(result.current).toBe(0);
  });
});
