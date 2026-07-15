import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Stub membershipApi — acceptInvite is the only call this page makes.
vi.mock('../../features/marketing/api/membershipApi', () => ({
  acceptInvite: vi.fn(() => Promise.resolve({ status: 'ACTIVE', workspaceId: 'ws1' })),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AcceptInvitePage from './AcceptInvitePage';

function renderPage(initialPath = '/accept-invite?token=tok-123') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AcceptInvitePage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and shows the accept form', () => {
    renderPage();
    expect(screen.getByText('Accept your invitation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept invitation/i })).toBeInTheDocument();
  });

  it('warns when the URL has no token', () => {
    renderPage('/accept-invite');
    expect(screen.getByText(/missing its token/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept invitation/i })).toBeDisabled();
  });

  it('submits acceptInvite with the token (and an optional password), then routes to /login', async () => {
    const { acceptInvite } = await import('../../features/marketing/api/membershipApi');
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    renderPage('/accept-invite?token=tok-123');

    await user.type(
      screen.getByLabelText(/set a password/i),
      'NewPassw0rd',
    );
    await user.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() => {
      expect(acceptInvite).toHaveBeenCalledWith({ token: 'tok-123', password: 'NewPassw0rd' });
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Invitation accepted — please log in.');
    });
    await waitFor(() => {
      expect(screen.getByText('Login Page')).toBeInTheDocument();
    });
  });

  it('submits with no password when the field is left blank (existing identity)', async () => {
    const { acceptInvite } = await import('../../features/marketing/api/membershipApi');
    const user = userEvent.setup();
    renderPage('/accept-invite?token=tok-456');

    await user.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() => {
      expect(acceptInvite).toHaveBeenCalledWith({ token: 'tok-456', password: undefined });
    });
  });

  it('shows the server error message on failure (e.g. expired token) and does not navigate', async () => {
    const { acceptInvite } = await import('../../features/marketing/api/membershipApi');
    vi.mocked(acceptInvite).mockRejectedValueOnce({
      response: { status: 401, data: { message: 'Invalid invite token' } },
    });
    const user = userEvent.setup();
    renderPage('/accept-invite?token=bad-token');

    await user.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid invite token')).toBeInTheDocument();
    });
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument();
  });
});
