import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import tr from '@/i18n/tr.json';
import { me, workspace } from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';

const NO_SESSION = withStatus(401, { code: 'UNAUTHENTICATED', message: 'no session', details: {} });

describe('Shell', () => {
  it('shows the menu, the workspace and its status in Turkish by default', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace });
    renderAt('/');
    const nav = (await screen.findAllByRole('navigation', { name: tr.nav.label }))[0];
    for (const label of [tr.nav.home, tr.nav.team, tr.nav.roles, tr.nav.apiKeys, tr.nav.agents, tr.nav.ledger]) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getAllByText('Alfa Atölye').length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe('tr');
  });

  it('sends a visitor to the sign-in page', async () => {
    mockFetch({ 'GET /api/auth/me': NO_SESSION });
    const { router } = renderAt('/team');
    expect(await screen.findByRole('heading', { level: 1, name: tr.login.title })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('sends an operator without a session to the platform sign-in page', async () => {
    mockFetch({ 'GET /api/platform/workspaces': NO_SESSION });
    const { router } = renderAt('/platform/workspaces');
    expect(
      await screen.findByRole('heading', { level: 1, name: tr.platform.login.title }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/platform/login');
  });
});
