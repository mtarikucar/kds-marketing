import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import MarketingUsersPage from './index';

const USERS = [
  {
    id: 'u1',
    firstName: 'Ada',
    lastName: 'Owner',
    email: 'ada@acme.com',
    role: 'OWNER',
    status: 'ACTIVE',
  },
  {
    id: 'u2',
    firstName: 'pending',
    lastName: '',
    email: 'pending@acme.com',
    role: 'REP',
    status: 'INVITED',
  },
];

vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/users') return Promise.resolve({ data: USERS });
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('@/features/marketing/api/membershipApi', () => ({
  inviteMember: vi.fn(() => Promise.resolve({ membershipId: 'm1', status: 'INVITED' })),
}));

// DistributionConfigCard fires its own /distribution-config query + uses
// react-i18next — irrelevant to this page's invite/status behavior, stub it
// out so the test doesn't have to also mock i18n.
vi.mock('@/features/marketing/components', () => ({
  DistributionConfigCard: () => null,
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

describe('MarketingUsersPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a Pending badge for an INVITED member', async () => {
    render(<MarketingUsersPage />, { wrapper });
    expect(await screen.findByText('Pending')).toBeInTheDocument();
    // The ACTIVE owner should read "Active", not the raw status string.
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('invite form submits inviteMember with email + role, and shows a success toast', async () => {
    const { inviteMember } = await import('@/features/marketing/api/membershipApi');
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    render(<MarketingUsersPage />, { wrapper });

    await screen.findByText('Pending'); // wait for the list to load first
    await user.click(screen.getByRole('button', { name: /invite member/i }));
    await user.type(await screen.findByLabelText(/email/i), 'newrep@acme.com');
    // Role select defaults to "Sales Rep" (REP) — leave as-is.
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => {
      expect(inviteMember).toHaveBeenCalledWith({ email: 'newrep@acme.com', role: 'REP' });
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Invitation sent to newrep@acme.com');
    });
  });

  it('offers "Cancel invite" (not "Reactivate") for an INVITED member', async () => {
    const user = userEvent.setup();
    render(<MarketingUsersPage />, { wrapper });

    await screen.findByText('Pending');
    const actionButtons = screen.getAllByRole('button', { name: /actions for/i });
    // Second row is the pending/invited member.
    await user.click(actionButtons[1]);

    expect(await screen.findByText('Cancel invite')).toBeInTheDocument();
    expect(screen.queryByText('Reactivate')).not.toBeInTheDocument();
  });
});
