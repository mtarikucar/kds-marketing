import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFailureCount } from './useFailureCount';
import { AgentActivity, ACTIVITY_LIMIT } from './AgentActivity';
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
  // 'DONE' / 'FAILED' is what agent-run.service writes — NOT 'SUCCEEDED'. The
  // vocabulary matters: 'DONE' is the status a run carries when the command
  // loop swallowed a broker tool failure and carried on, which is the exact
  // shape that used to be counted by the badge and drawn green by the panel.
  status: 'DONE',
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

  // The command loop hands a broker tool failure back to the model as
  // `{ error }` and lets the run finish, so the run's own status is 'DONE'
  // while the tool call was written `ok: false`. Nothing else on the home
  // screen mentions it. Judging on status alone would call this a good day.
  it('counts a completed run that quietly lost a tool call', async () => {
    listAgentRuns.mockResolvedValue([
      run({
        id: 'r1',
        status: 'DONE',
        toolCalls: [call({ id: 'c1', ok: true }), call({ id: 'c2', ok: false })],
      }),
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

  // The second of the two ways work is lost: the run never got far enough to
  // record a tool call, so there is no `ok: false` to find and only `status`
  // says anything went wrong.
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

  // THE test this file was missing. Every other case here checks the hook
  // against a number I worked out by hand, which only ever proves the hook
  // agrees with ME. This one checks it against what the panel PUTS ON SCREEN,
  // which is the only claim the badge actually makes.
  //
  // The fixture is built to fail in both of the ways the hand-computed tests
  // could not see:
  //   - `r0` is 'DONE' with a not-ok call — the panel used to draw this with a
  //     green check while the badge counted it (the verdict divergence);
  //   - `r8` is a real failure sitting one past ACTIVITY_LIMIT — the badge used
  //     to count it forever while the tab showed eight clean rows (the window
  //     divergence). The backend takes 50 runs with no time window, so this is
  //     the steady state of any workspace past its first day, not an edge case.
  //
  // `r0` is also the control that keeps the expectation non-zero: an agreement
  // test whose expected count is 0 is satisfied by the loading state before the
  // fetch resolves, which is how the newsworthy filter slipped through earlier.
  it('counts exactly the runs the panel paints as failed, no more and no fewer', async () => {
    const healthy = Array.from({ length: ACTIVITY_LIMIT - 1 }, (_, i) =>
      run({ id: `ok${i}`, status: 'DONE', toolCalls: [call({ ok: true })] }),
    );
    listAgentRuns.mockResolvedValue([
      run({ id: 'r0', status: 'DONE', toolCalls: [call({ ok: false })] }),
      ...healthy,
      run({ id: 'r8', status: 'FAILED', goal: 'dünkü hata', toolCalls: [] }),
    ]);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <AgentActivity />
        {children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useFailureCount(), { wrapper });

    // The panel has finished drawing, and drew its window — not all nine.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-failed]')).toHaveLength(ACTIVITY_LIMIT),
    );

    const drawnAsFailed = document.querySelectorAll('[data-failed="true"]').length;
    // Absolute, so that breaking BOTH sides in the same direction still fails.
    expect(drawnAsFailed).toBe(1);
    expect(result.current).toBe(drawnAsFailed);
    // And it is the run we think it is.
    expect(document.querySelector('[data-testid="run-r0"]')).toHaveAttribute('data-failed', 'true');
    expect(document.querySelector('[data-testid="run-r8"]')).toBeNull();
  });

  // The same invariant as the agreement test, stated without the DOM: it is the
  // hook alone that must respect the panel's window.
  //
  // Deliberately sized FROM `ACTIVITY_LIMIT` rather than from a literal 8, so
  // it tracks the panel's window instead of pinning a layout number — widening
  // the cap on both sides keeps the badge honest and should not fail anything.
  // (Verified: mutating ACTIVITY_LIMIT to 50 leaves this green, which is
  // correct. What must never go green is the hook counting past whatever the
  // window is — that is the "lit forever over a failure the tab cannot show"
  // state, and it fails here.)
  it('does not count a failure that fell off the end of the panel window', async () => {
    const healthy = Array.from({ length: ACTIVITY_LIMIT }, (_, i) =>
      run({ id: `ok${i}`, status: 'DONE', toolCalls: [call({ ok: true })] }),
    );
    listAgentRuns.mockResolvedValue([
      run({ id: 'inside', status: 'FAILED', goal: 'bugünkü hata', toolCalls: [] }),
      ...healthy.slice(1),
      run({ id: 'outside', status: 'FAILED', goal: 'eski hata', toolCalls: [] }),
    ]);
    const { result } = renderCount();
    await waitFor(() => expect(result.current).toBe(1));
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
