import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Stub platformApi
vi.mock('../../features/platform/api/platformApi', () => ({
  default: {
    post: vi.fn(() =>
      Promise.resolve({
        data: { operator: { id: 'op1', email: 'ops@platform' }, accessToken: 'at' },
      }),
    ),
  },
}));

// Stub the platform auth store — not authenticated by default.
vi.mock('../../store/platformAuthStore', () => ({
  usePlatformAuthStore: () => ({
    login: vi.fn(),
    isAuthenticated: false,
  }),
}));

import PlatformLoginPage from './PlatformLoginPage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/platform/login']}>
      <Routes>
        <Route path="/platform/login" element={<PlatformLoginPage />} />
        <Route path="/platform/workspaces" element={<div>Workspaces</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PlatformLoginPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and shows Platform Console heading', () => {
    renderPage();
    expect(screen.getByText('Platform Console')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('shows validation errors when submitting empty form', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
  });

  it('calls platformApi.post /auth/login on valid submit', async () => {
    const { default: platformApi } = await import('../../features/platform/api/platformApi');
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/email/i), 'ops@platform.internal');
    await user.type(screen.getByLabelText(/password/i), 'Secret123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => {
      expect(platformApi.post).toHaveBeenCalledWith('/auth/login', {
        email: 'ops@platform.internal',
        password: 'Secret123',
      });
    });
  });
});
