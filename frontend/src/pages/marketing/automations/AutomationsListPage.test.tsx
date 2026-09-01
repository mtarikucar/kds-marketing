import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AutomationsListPage from './AutomationsListPage';

const { navigateMock, ROWS } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  ROWS: [
    { id: '1', name: 'Welcome flow', status: 'ACTIVE', version: 1, trigger: { type: 'lead.created' }, stats: { started: 5, completed: 2 } },
    { id: '2', name: 'Win-back', status: 'PAUSED', version: 1, trigger: { type: 'lead.status_changed' }, stats: { started: 0, completed: 0 } },
  ],
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url.includes('/templates')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: ROWS });
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string | string[], d?: unknown) => (typeof d === 'string' ? d : Array.isArray(k) ? k[0] : k),
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AutomationsListPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists workflows and narrows by search', async () => {
    render(<AutomationsListPage />, { wrapper });
    expect(await screen.findByText('Welcome flow')).toBeInTheDocument();
    expect(screen.getByText('Win-back')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox', { name: /search/i }), 'win');
    await waitFor(() => {
      expect(screen.queryByText('Welcome flow')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Win-back')).toBeInTheDocument();
  });

  it('Edit navigates to the builder route (no builder modal)', async () => {
    render(<AutomationsListPage />, { wrapper });
    await screen.findByText('Welcome flow');
    const editButtons = screen.getAllByRole('button', { name: /edit/i });
    await userEvent.click(editButtons[0]);
    expect(navigateMock).toHaveBeenCalledWith('/automations/1/edit');
  });
});

/**
 * `embedded` + `onNavigate`, for the Studio's `?tool=ops` drawer.
 *
 * The builder is a `fullBleed` route of its own, so every create/edit here
 * leaves the screen the drawer is open on. The host needs that moment to drop
 * its `?tool=ops` (its close is a `replace`), or the operator returns from the
 * builder to a drawer they did not ask to reopen.
 */
describe('AutomationsListPage — hosted inside another screen', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops its own PageHeader when embedded', async () => {
    render(<AutomationsListPage embedded />, { wrapper });

    // Positive anchor: the list itself is fully there.
    expect(await screen.findByText('Welcome flow')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Automations' })).not.toBeInTheDocument();
  });

  it('tells its host BEFORE it navigates to the builder', async () => {
    const onNavigate = vi.fn();
    render(<AutomationsListPage embedded onNavigate={onNavigate} />, { wrapper });

    await userEvent.click((await screen.findAllByRole("button", { name: /Edit/i }))[0]);

    expect(onNavigate).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/automations/1/edit');
    // Order matters: the host's parameter must be gone from the URL before the
    // push, or the entry the back button returns to still carries it.
    expect(onNavigate.mock.invocationCallOrder[0]).toBeLessThan(
      navigateMock.mock.invocationCallOrder[0],
    );
  });

  it('navigates perfectly well with no host listening', async () => {
    render(<AutomationsListPage />, { wrapper });

    await userEvent.click((await screen.findAllByRole("button", { name: /Edit/i }))[0]);
    expect(navigateMock).toHaveBeenCalledWith('/automations/1/edit');
  });
});
