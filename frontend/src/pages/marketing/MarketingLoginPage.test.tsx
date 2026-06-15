import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Stub i18n — t echoes the key so we can match on i18n keys.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], _opts?: unknown) => {
      return Array.isArray(key) ? key[0] : key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

// Stub marketingApi
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    post: vi.fn(() =>
      Promise.resolve({
        data: { user: { id: '1', email: 'a@b.com', firstName: 'A', lastName: 'B', role: 'OWNER', workspaceId: 'ws1' }, accessToken: 'at', refreshToken: 'rt' },
      }),
    ),
  },
}));

// Stub the auth store — isolated, not authenticated by default.
vi.mock('../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({
    login: vi.fn(),
    isAuthenticated: false,
  }),
}));

import MarketingLoginPage from './MarketingLoginPage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<MarketingLoginPage />} />
        <Route path="/dashboard" element={<div>Dashboard</div>} />
        <Route path="/register" element={<div>Register</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MarketingLoginPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and shows title + submit button', () => {
    renderPage();
    expect(screen.getByText('login.title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /login.submit/i })).toBeInTheDocument();
  });

  it('shows validation errors when submitting empty form', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /login.submit/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
  });

  it('calls marketingApi.post /auth/login on valid submit', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/login.emailLabel/i), 'test@example.com');
    await user.type(screen.getByLabelText(/login.passwordLabel/i), 'password123');
    await user.click(screen.getByRole('button', { name: /login.submit/i }));
    await waitFor(() => {
      expect(marketingApi.post).toHaveBeenCalledWith('/auth/login', {
        email: 'test@example.com',
        password: 'password123',
      });
    });
  });

  it('shows a register link', () => {
    renderPage();
    expect(screen.getByRole('link', { name: /register.cta/i })).toBeInTheDocument();
  });
});
