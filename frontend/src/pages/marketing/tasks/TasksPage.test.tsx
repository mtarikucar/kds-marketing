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
