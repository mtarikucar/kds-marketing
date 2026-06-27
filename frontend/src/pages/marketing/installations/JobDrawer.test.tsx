import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobDrawer } from './JobDrawer';

const get = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ user: { role: 'MANAGER', id: 'u-1' } }),
}));

const job = (id: string, contactName: string) => ({
  id,
  status: 'REQUESTED',
  contactName,
  siteAddress: '1 Main St',
  siteCity: 'Town',
  contactPhone: null,
  notes: null,
  tasks: [],
});

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('JobDrawer — per-job state reset', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (url === '/installations/jobs/jA') return Promise.resolve({ data: job('jA', 'Alpha Co') });
      if (url === '/installations/jobs/jB') return Promise.resolve({ data: job('jB', 'Beta Co') });
      return Promise.resolve({ data: {} });
    });
  });

  // Regression: the parent mounts the drawer persistently (jobId is a prop, not
  // a mount gate), so the schedule form + new-task input must reset when the
  // opened job changes — otherwise a value entered for job A leaks onto job B
  // and could be submitted against the wrong job.
  it('clears the new-task input when switching to another job', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <JobDrawer jobId="jA" crews={[]} onClose={() => undefined} onChanged={() => undefined} />,
      { wrapper },
    );

    await screen.findByText('Alpha Co');
    const taskInput = screen.getByPlaceholderText('Add task…');
    await user.type(taskInput, 'Install panel for A');
    expect(taskInput).toHaveValue('Install panel for A');

    rerender(<JobDrawer jobId="jB" crews={[]} onClose={() => undefined} onChanged={() => undefined} />);
    await screen.findByText('Beta Co');

    expect(screen.getByPlaceholderText('Add task…')).toHaveValue('');
  });
});
