import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TasksPage from './TasksPage';

const getMock = vi.fn();
const postMock = vi.fn().mockResolvedValue({ data: {} });
const patchMock = vi.fn().mockResolvedValue({ data: {} });
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ user: { workspaceId: 'ws-1', role: 'MANAGER', id: 'u-1' } }),
}));

// Resolve t(key, default) to the default string (or the key) so assertions are
// deterministic without bootstrapping the full i18n catalogue.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

const TASK = {
  id: 't1',
  title: 'Call the lead',
  type: 'CALL',
  priority: 'HIGH',
  status: 'PENDING',
  dueDate: '2026-07-01T10:00:00Z',
  assignedTo: null,
  lead: null,
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('TasksPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchMock.mockResolvedValue({ data: {} });
    getMock.mockImplementation((url: string) => {
      if (url === '/tasks') return Promise.resolve({ data: { data: [TASK], meta: { total: 1 } } });
      if (url === '/users')
        return Promise.resolve({
          data: [{ id: 'u-1', firstName: 'Tarik', lastName: 'U', role: 'MANAGER' }],
        });
      return Promise.resolve({ data: {} });
    });
  });

  it('mounts without crashing and fetches reps for a manager', async () => {
    const { container } = render(<TasksPage />, { wrapper });
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/users'));
    expect(getMock).toHaveBeenCalledWith('/tasks', expect.anything());
    expect(container.querySelector('table')).toBeTruthy();
  });

  // The "all" tab is paginated server-side (20/page), so client-only column
  // sorting just reordered the visible 20. A sortable header must drive a
  // server sort so the top rows reflect the whole dataset's order.
  it('forwards sortBy/sortOrder to /tasks when a sortable header is clicked', async () => {
    render(<TasksPage />, { wrapper });
    expect(await screen.findByText('Call the lead')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'tasks.table.dueDate' }));

    await waitFor(() => {
      const tasksCalls = getMock.mock.calls.filter((c) => c[0] === '/tasks');
      const last = tasksCalls[tasksCalls.length - 1] as [string, { params?: Record<string, unknown> }];
      expect(last?.[1]?.params?.sortBy).toBe('dueDate');
      expect(last?.[1]?.params?.sortOrder).toBe('asc');
    });
  });

  // assignedTo is not in the backend sort allow-list (and sorting by the rep
  // object is meaningless), so its header must not be an interactive sort
  // button — otherwise a click would silently no-op server-side.
  it('does not offer sorting on the assignedTo column', async () => {
    render(<TasksPage />, { wrapper });
    expect(await screen.findByText('Call the lead')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'tasks.table.assignedTo' }),
    ).not.toBeInTheDocument();
  });

  // Regression (per-row mutation loading bug class): the per-row "complete"
  // button drove its disabled state off the SHARED completeMutation.isPending,
  // so completing one task disabled EVERY task's complete button until the
  // request resolved — you couldn't tick off tasks in quick succession. The
  // in-flight row's own button must disable (no double-fire), but the others
  // must stay enabled.
  it('keeps other rows\' complete buttons enabled while one task is completing', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/tasks')
        return Promise.resolve({
          data: {
            data: [TASK, { ...TASK, id: 't2', title: 'Email the client' }],
            meta: { total: 2 },
          },
        });
      if (url === '/users')
        return Promise.resolve({
          data: [{ id: 'u-1', firstName: 'Tarik', lastName: 'U', role: 'MANAGER' }],
        });
      return Promise.resolve({ data: {} });
    });
    // Stall the complete request so the mutation stays in flight for the assertion.
    patchMock.mockImplementation(() => new Promise(() => {}));

    render(<TasksPage />, { wrapper });
    await screen.findByText('Call the lead');
    await screen.findByText('Email the client');

    const before = screen.getAllByRole('button', { name: 'tasks.completeSuccess' });
    expect(before).toHaveLength(2);

    // Complete the first task → its mutation is now in flight.
    await userEvent.click(before[0]);

    const after = screen.getAllByRole('button', { name: 'tasks.completeSuccess' });
    // The in-flight row's own button is disabled (prevents a double-fire)…
    expect(after[0]).toBeDisabled();
    // …but the OTHER row's complete button must stay clickable.
    expect(after[1]).not.toBeDisabled();
  });

  // Regression: the delete confirmation used t('tasks.empty') ("No tasks here.")
  // as its body — a copy-paste from the empty state. It must warn about the
  // deletion instead.
  it('shows a deletion warning (not the empty-state text) in the delete confirm', async () => {
    render(<TasksPage />, { wrapper });
    expect(await screen.findByText('Call the lead')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'common.actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'common.delete' }));

    expect(
      await screen.findByText(
        'This task will be permanently deleted. This cannot be undone.',
      ),
    ).toBeInTheDocument();
    // The empty-state key must NOT be the dialog body.
    expect(screen.queryByText('tasks.empty')).not.toBeInTheDocument();
  });
});


/**
 * The task list as the person surface's **Görevler** view (2026-09-01 design,
 * stage 2). Same prop, same meaning, same one implementation as every other
 * embedded page on this surface: the chrome is swapped for the host's and
 * nothing else moves. The tabs, the status filter, the server sort, complete /
 * edit / delete and the create dialog all come along.
 */
describe('TasksPage — embedded as the surface Görevler view', () => {
  const WITH_LEAD = {
    ...TASK,
    lead: { id: 'lead-1', businessName: 'Acme Kafe' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    patchMock.mockResolvedValue({ data: {} });
    getMock.mockImplementation((url: string) => {
      if (url === '/tasks')
        return Promise.resolve({ data: { data: [WITH_LEAD], meta: { total: 1 } } });
      if (url === '/users')
        return Promise.resolve({
          data: [{ id: 'u-1', firstName: 'Tarik', lastName: 'U', role: 'MANAGER' }],
        });
      return Promise.resolve({ data: {} });
    });
  });

  it('drops its own page chrome and keeps the list', async () => {
    render(<TasksPage embedded />, { wrapper });

    expect(await screen.findByText('Call the lead')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('keeps creating a task — that is a capability, not chrome', async () => {
    render(<TasksPage embedded />, { wrapper });
    await screen.findByText('Call the lead');

    await userEvent.click(screen.getByRole('button', { name: 'tasks.createButton' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the three tabs and the status filter', async () => {
    render(<TasksPage embedded />, { wrapper });
    await screen.findByText('Call the lead');

    await userEvent.click(screen.getByRole('button', { name: 'tasks.tabs.overdue' }));
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/tasks/overdue'));
  });

  /**
   * The whole point of the view: a task names a person, and clicking that name
   * opens their conversation in the middle column. On `/tasks` the same name is
   * a LINK into their record, because there is no surface there to report to —
   * and that difference is the one thing this view changes.
   */
  it('reports the task\'s person up instead of navigating', async () => {
    const onSelectPerson = vi.fn();
    render(<TasksPage embedded onSelectPerson={onSelectPerson} />, { wrapper });

    await userEvent.click(await screen.findByTestId('task-lead-t1'));

    expect(onSelectPerson).toHaveBeenCalledWith(expect.objectContaining({ id: 'lead-1' }));
  });

  it('marks the person the surface has open', async () => {
    render(
      <TasksPage embedded onSelectPerson={vi.fn()} selectedLeadId="lead-1" />,
      { wrapper },
    );

    expect(await screen.findByTestId('task-lead-t1')).toHaveAttribute('aria-current', 'true');
  });

  it('leaves /tasks navigating into the record, as it always has', async () => {
    render(<TasksPage />, { wrapper });

    const link = await screen.findByRole('link', { name: 'Acme Kafe' });
    expect(link).toHaveAttribute('href', '/leads/lead-1');
  });

  /**
   * The repo's central rule, and this list did not follow it: the query read
   * only `isLoading`, so a failed `/tasks` fell through to the DataTable's
   * EMPTY state — "No tasks here." — with a "New task" button under it. As a
   * column of the person surface that reads as "this queue is clear", which is
   * the most expensive thing a work list can lie about.
   */
  it('says the list could not be read rather than showing it empty', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/tasks') return Promise.reject(new Error('boom'));
      if (url === '/users') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
    render(<TasksPage embedded />, { wrapper });

    // Positive anchor first: the absence below would pass instantly against a
    // list that is merely still loading.
    expect(await screen.findByText('Could not load tasks.')).toBeInTheDocument();
    expect(screen.queryByText('tasks.empty')).not.toBeInTheDocument();
  });

  it('says it is empty only once it has actually been read', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/tasks') return Promise.resolve({ data: { data: [], meta: { total: 0 } } });
      if (url === '/users') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
    render(<TasksPage embedded />, { wrapper });

    expect(await screen.findByText('tasks.empty')).toBeInTheDocument();
    expect(screen.queryByText('Could not load tasks.')).not.toBeInTheDocument();
  });

  /**
   * The other half of the invalidation contract. `useLeadRecordActions` now
   * names ['marketing','tasks'] so a write on the record CARD refreshes this
   * list; this is the same round trip in the other direction — a task completed
   * HERE has to refresh the person's record beside it, or the card's GÖREVLER
   * section keeps showing a task the rep just ticked off two columns away.
   */
  it('refreshes the open person\'s record when a task is completed here', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <TasksPage embedded />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText('Call the lead');

    await userEvent.click(screen.getByRole('button', { name: 'tasks.completeSuccess' }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'lead'] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'tasks'] });
  });
});
