import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Stub i18n — `t(key, default)` answers with the English default, so the
// assertions below read as the page reads.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: unknown) => (typeof def === 'string' ? def : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: { post: vi.fn(() => Promise.resolve({ data: { message: 'ok' } })) },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ResetPasswordPage from './ResetPasswordPage';

function renderPage(entry = '/reset-password?token=tok-123') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/forgot-password" element={<div>Forgot Page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * `no-password-recovery`: the backend mails
 * `${FRONTEND_URL}/reset-password?token=…`. Without this page the SPA's
 * catch-all sent the locked-out owner to the landing page and dropped the
 * token, burning the 30-minute link on the way.
 */
describe('ResetPasswordPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to submit a link that arrived without a token', () => {
    renderPage('/reset-password');
    expect(screen.getByText(/missing its token/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set a new password/i })).toBeDisabled();
  });

  it('posts the token and the new password, then sends the owner to sign in again', async () => {
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default;
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/^new password$/i), 'NewPassw0rd');
    await user.type(screen.getByLabelText(/confirm/i), 'NewPassw0rd');
    await user.click(screen.getByRole('button', { name: /set a new password/i }));

    await waitFor(() => {
      expect(marketingApi.post).toHaveBeenCalledWith('/auth/reset-password', {
        token: 'tok-123',
        newPassword: 'NewPassw0rd',
      });
    });
    await waitFor(() => expect(screen.getByText('Login Page')).toBeInTheDocument());
    expect(toast.success).toHaveBeenCalled();
  });

  it('refuses a password the backend policy would refuse, before spending the link', async () => {
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default;
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/^new password$/i), 'alllowercase1');
    await user.type(screen.getByLabelText(/confirm/i), 'alllowercase1');
    await user.click(screen.getByRole('button', { name: /set a new password/i }));

    await waitFor(() => expect(screen.getByText(/uppercase/i)).toBeInTheDocument());
    expect(marketingApi.post).not.toHaveBeenCalled();
  });

  it('will not submit two passwords that disagree', async () => {
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default;
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/^new password$/i), 'NewPassw0rd');
    await user.type(screen.getByLabelText(/confirm/i), 'NewPassw0rdX');
    await user.click(screen.getByRole('button', { name: /set a new password/i }));

    await waitFor(() => expect(screen.getByText(/do not match/i)).toBeInTheDocument());
    expect(marketingApi.post).not.toHaveBeenCalled();
  });

  it('shows one spent-link state for every rejection, and a way to ask for another', async () => {
    // The service answers expiry, a bad signature and an already-spent token
    // with the SAME message on purpose. The UI must not invent a distinction
    // it was deliberately denied.
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default;
    vi.mocked(marketingApi.post).mockRejectedValueOnce({
      response: { status: 400, data: { message: 'Reset link is invalid or has expired' } },
    });
    const user = userEvent.setup();
    renderPage('/reset-password?token=stale');

    await user.type(screen.getByLabelText(/^new password$/i), 'NewPassw0rd');
    await user.type(screen.getByLabelText(/confirm/i), 'NewPassw0rd');
    await user.click(screen.getByRole('button', { name: /set a new password/i }));

    await waitFor(() =>
      expect(screen.getByText(/expired or has already been used/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /request a new/i })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument();
  });
});

/**
 * The defect was never in the page — it was that no route pointed at one. A
 * unit test of a component nobody can reach would have stayed green through
 * the whole outage, so the route table itself is asserted here.
 */
describe('the mailed link has somewhere to land', () => {
  const app = import.meta.glob('/src/App.tsx', { eager: true, query: '?raw', import: 'default' }) as Record<
    string,
    string
  >;
  const source = Object.values(app)[0] ?? '';

  it('routes /reset-password and /forgot-password', () => {
    expect(source).toMatch(/path="\/reset-password"/);
    expect(source).toMatch(/path="\/forgot-password"/);
  });

  it('keeps both public — the caller has no session by definition', () => {
    const guardAt = source.indexOf('<MarketingProtectedRoute />');
    expect(guardAt).toBeGreaterThan(-1);
    expect(source.indexOf('path="/reset-password"')).toBeLessThan(guardAt);
    expect(source.indexOf('path="/forgot-password"')).toBeLessThan(guardAt);
  });
});
