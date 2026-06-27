import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TasksPage from './TasksPage';

const getMock = vi.fn();
const postMock = vi.fn().mockResolvedValue({ data: {} });
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    patch: vi.fn().mockResolvedValue({ data: {} }),
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
