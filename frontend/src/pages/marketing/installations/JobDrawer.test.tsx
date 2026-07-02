import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobDrawer } from './JobDrawer';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: (...args: unknown[]) => patch(...args),
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

describe('JobDrawer — add-task double-submit guard', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) =>
      url === '/installations/jobs/jA'
        ? Promise.resolve({ data: job('jA', 'Alpha Co') })
        : Promise.resolve({ data: {} }),
    );
  });

  // Regression: the Add button is disabled while the POST is pending, but the
  // Enter handler bypassed that guard — Enter-spam added the same task twice.
  it('does not add the same task twice on Enter while the first POST is in flight', async () => {
    const { default: api } = await import('../../../features/marketing/api/marketingApi');
    (api.post as unknown as ReturnType<typeof vi.fn>).mockReset();
    (api.post as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));

    const user = userEvent.setup();
    render(<JobDrawer jobId="jA" crews={[]} onClose={() => undefined} onChanged={() => undefined} />, { wrapper });
    await screen.findByText('Alpha Co');

    const input = screen.getByPlaceholderText('Add task…');
    await user.type(input, 'wire the panel');
    await user.keyboard('{Enter}'); // first add → pending
    await user.keyboard('{Enter}'); // second Enter while pending → must be ignored

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/installations/jobs/jA/tasks', { title: 'wire the panel' });
  });
});

describe('JobDrawer — confirm irreversible status transitions', () => {
  beforeEach(() => {
    get.mockReset();
    patch.mockReset();
    patch.mockResolvedValue({ data: {} });
    get.mockImplementation((url: string) =>
      url === '/installations/jobs/jA'
        ? Promise.resolve({ data: { ...job('jA', 'Alpha Co'), status: 'SCHEDULED' } })
        : Promise.resolve({ data: {} }),
    );
  });

  it('confirms before CANCELLED — a stray click must not cancel the installation', async () => {
    const user = userEvent.setup();
    render(<JobDrawer jobId="jA" crews={[]} onClose={() => undefined} onChanged={() => undefined} />, { wrapper });
    await screen.findByText('Alpha Co');

    // The row transition button carries the status label 'Cancelled'; clicking it
    // must open a confirm, NOT immediately cancel (the move is irreversible).
    await user.click(screen.getByRole('button', { name: 'Cancelled' }));
    expect(patch).not.toHaveBeenCalled();

    // Confirming (distinct label) fires the status change.
    await user.click(await screen.findByRole('button', { name: 'Cancel installation' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/installations/jobs/jA/status', { status: 'CANCELLED' }),
    );
  });

  it('fires a normal transition (In Progress) immediately, without a confirm', async () => {
    const user = userEvent.setup();
    render(<JobDrawer jobId="jA" crews={[]} onClose={() => undefined} onChanged={() => undefined} />, { wrapper });
    await screen.findByText('Alpha Co');

    await user.click(screen.getByRole('button', { name: 'In Progress' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/installations/jobs/jA/status', { status: 'IN_PROGRESS' }),
    );
  });
});
