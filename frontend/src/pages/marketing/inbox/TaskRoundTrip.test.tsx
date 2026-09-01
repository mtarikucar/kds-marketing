import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PersonTasks } from './PersonTasks';
import TasksPage from '../tasks/TasksPage';

/**
 * The invalidation contract, end to end, on the two REAL components that make
 * it matter.
 *
 * `useLeadRecordActions.ts` says in prose that a new consumer must add its key
 * to the invalidation set, and stage 2's Görevler view is that consumer: it
 * reads `GET /tasks` under `['marketing','tasks', …]`, which none of the three
 * keys that set used to name prefix-matches. So a rep ticking a task off the
 * record card left the very same task sitting in the left column beside it.
 *
 * Two unit tests already pin each half — the key is in the set
 * (`useLeadRecordActions.test.tsx`), and the list refreshes the person's record
 * on its own writes (`TasksPage.test.tsx`). Neither can catch the thing that
 * actually breaks: that the key the CARD invalidates is a prefix of the key the
 * LIST reads. A rename of either — `['marketing','tasks']` to
 * `['marketing','task']`, a list key moved under `['marketing','workspace',
 * 'tasks']` — passes both unit tests and silently reopens the bug. This mounts
 * the card's GÖREVLER section and the surface's Görevler view side by side
 * under one QueryClient, exactly as the surface does, and counts requests.
 */

const get = vi.fn();
const patch = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: (...a: unknown[]) => patch(...a),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel?: (s: unknown) => unknown) => {
    const state = { user: { id: 'u-1', role: 'MANAGER', workspaceId: 'ws-1' } };
    return sel ? sel(state) : state;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

const TASK = {
  id: 't1',
  title: 'Ayşe’yi ara',
  type: 'CALL',
  priority: 'HIGH',
  status: 'PENDING',
  dueDate: '2026-09-10T09:00:00Z',
  assignedTo: null,
  lead: { id: 'l1', businessName: 'Acme Kafe' },
};

/** How many times the workspace task list has been asked for. */
const listReads = () => get.mock.calls.filter((c) => c[0] === '/tasks').length;

function renderBoth() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        {/* The left column's Görevler view… */}
        <TasksPage embedded />
        {/* …and the record card's GÖREVLER section, for the same person. */}
        <PersonTasks leadId="l1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('a task completed on the record card refreshes the left column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patch.mockResolvedValue({ data: {} });
    get.mockImplementation((url: string) => {
      if (url === '/tasks') return Promise.resolve({ data: { data: [TASK], meta: { total: 1 } } });
      if (url === '/leads/l1') return Promise.resolve({ data: { id: 'l1', tasks: [TASK] } });
      return Promise.resolve({ data: [] });
    });
  });

  it('re-reads the workspace task list, not just the person’s record', async () => {
    renderBoth();

    // Both halves are up and showing the same task. Anchoring on the LIST's
    // copy matters: without it the count below could be satisfied by a list
    // that never rendered.
    await waitFor(() => expect(screen.getAllByText('Ayşe’yi ara')).toHaveLength(2));
    const before = listReads();
    expect(before).toBeGreaterThan(0);

    // The record card's own complete control — TasksTab's circle, driven by
    // useLeadTaskActions, which is the hook whose invalidation set is on trial.
    await userEvent.click(screen.getByRole('button', { name: 'Mark complete' }));

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/tasks/t1/complete'));
    await waitFor(() => expect(listReads()).toBeGreaterThan(before));
  });

  it('re-reads the person’s record too — the card must not go stale either', async () => {
    renderBoth();
    await waitFor(() => expect(screen.getAllByText('Ayşe’yi ara')).toHaveLength(2));
    const before = get.mock.calls.filter((c) => c[0] === '/leads/l1').length;

    await userEvent.click(screen.getByRole('button', { name: 'Mark complete' }));

    await waitFor(() =>
      expect(get.mock.calls.filter((c) => c[0] === '/leads/l1').length).toBeGreaterThan(before),
    );
  });
});
