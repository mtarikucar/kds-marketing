import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import MarketingProtectedRoute from './MarketingProtectedRoute';
import { useMarketingAuthStore, type MarketingUser } from '../../../store/marketingAuthStore';

const baseUser: MarketingUser = {
  id: 'u1',
  workspaceId: 'ws1',
  email: 'a@b.com',
  firstName: 'A',
  lastName: 'B',
  role: 'OWNER',
};

const initialState = useMarketingAuthStore.getState();

function renderGuarded() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route element={<MarketingProtectedRoute />}>
          <Route path="/dashboard" element={<div>Dashboard content</div>} />
        </Route>
        <Route path="/login" element={<div>Login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Orphaned-session handling (multi-workspace membership), route-guard half:
 * marketingApi.test.ts proves the 401/refresh-fail path clears the store
 * (logout()). This proves the OTHER half — once the store is cleared, a
 * user sitting on an already-mounted protected page is routed to /login
 * rather than stuck showing dead content with no working session.
 */
describe('MarketingProtectedRoute — orphaned session', () => {
  afterEach(() => {
    useMarketingAuthStore.setState(initialState, true);
  });

  it('renders the protected content while authenticated', () => {
    // Must be JWT-shaped (header.payload.sig) with a future `exp` — the
    // component decodes it on mount and logs out on anything that isn't a
    // valid, unexpired token (see the expired-token test below).
    const validPayload = { exp: Math.floor(Date.now() / 1000) + 3600 };
    const validToken = `header.${btoa(JSON.stringify(validPayload))}.sig`;

    useMarketingAuthStore.setState({
      ...initialState,
      user: baseUser,
      accessToken: validToken,
      refreshToken: 'live-refresh-token',
      isAuthenticated: true,
    });

    renderGuarded();

    expect(screen.getByText('Dashboard content')).toBeInTheDocument();
  });

  it('redirects to /login once the store is cleared (e.g. by the interceptor logout on a dead session)', () => {
    // Mirrors the post-logout() state: sole membership was suspended/removed
    // mid-session, the 401->refresh-fails->logout() chain already ran.
    useMarketingAuthStore.setState({
      ...initialState,
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
    });

    renderGuarded();

    expect(screen.getByText('Login page')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard content')).not.toBeInTheDocument();
  });

  it('logs out and redirects when the access token it decodes is expired, even if isAuthenticated was left stale true', () => {
    // Defense in depth: a token whose exp has already passed must not leave
    // the user parked on the page — the effect calls logout() synchronously
    // on mount, which flips isAuthenticated to false on the next render.
    const expiredPayload = { exp: Math.floor(Date.now() / 1000) - 60 };
    const expiredToken = `header.${btoa(JSON.stringify(expiredPayload))}.sig`;

    useMarketingAuthStore.setState({
      ...initialState,
      user: baseUser,
      accessToken: expiredToken,
      refreshToken: 'live-refresh-token',
      isAuthenticated: true,
    });

    renderGuarded();

    expect(screen.getByText('Login page')).toBeInTheDocument();
    expect(useMarketingAuthStore.getState().isAuthenticated).toBe(false);
  });
});
