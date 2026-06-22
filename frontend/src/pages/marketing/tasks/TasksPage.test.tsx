import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
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
      if (url === '/tasks') return Promise.resolve({ data: { data: [], meta: { total: 0 } } });
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
    // The task list query also runs.
    expect(getMock).toHaveBeenCalledWith('/tasks', expect.anything());
    // Rendered something (no crash).
    expect(container.querySelector('table')).toBeTruthy();
  });
});
