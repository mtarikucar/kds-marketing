import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: unknown) => (typeof def === 'string' ? def : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: { post: vi.fn(() => Promise.resolve({ data: { message: 'ok' } })) },
}));

import ForgotPasswordPage from './ForgotPasswordPage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ForgotPasswordPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks the backend for a reset link', async () => {
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default;
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/email/i), 'owner@acme.test');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(marketingApi.post).toHaveBeenCalledWith('/auth/forgot-password', {
        email: 'owner@acme.test',
      }),
    );
    expect(screen.getByText(/if that address has an account/i)).toBeInTheDocument();
  });

  it('answers a failed request exactly like a successful one', async () => {
    // The service spends a dummy bcrypt compare so an unknown address costs
    // the same as a known one. A UI that surfaced the error would hand the
    // enumeration oracle straight back.
    const marketingApi = (await import('../../features/marketing/api/marketingApi')).default;
    vi.mocked(marketingApi.post).mockRejectedValueOnce({
      response: { status: 429, data: { message: 'Too many requests' } },
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/email/i), 'nobody@acme.test');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/if that address has an account/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/too many requests/i)).not.toBeInTheDocument();
  });
});
