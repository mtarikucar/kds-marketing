import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { MeOut } from '@/api/types';
import { WS_ID, me, workspace } from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';

const NO_SESSION = withStatus(401, { code: 'UNAUTHENTICATED', message: 'no session', details: {} });

describe('Shell', () => {
  it('shows the menu, the workspace and its status in Turkish by default', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace });
    renderAt('/');
    const nav = (await screen.findAllByRole('navigation', { name: tr.nav.label }))[0];
    for (const label of [
      tr.nav.home,
      tr.nav.strategy,
      tr.nav.capabilities,
      tr.nav.budget,
      tr.nav.team,
      tr.nav.roles,
      tr.nav.apiKeys,
      tr.nav.agents,
      tr.nav.ledger,
    ]) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getAllByText('Alfa Atölye').length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe('tr');
  });

  it('shows only the name, without a switcher, for a single current workspace', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace });
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: tr.shell.switchWorkspace })).not.toBeInTheDocument();
  });

  it('offers the switcher when there is a membership but no current workspace', async () => {
    const user = userEvent.setup();
    const adrift: MeOut = { ...me, current_workspace: null };
    const calls = mockFetch({
      'GET /api/auth/me': adrift,
      'POST /api/auth/switch-workspace': me,
      'GET /api/workspace': workspace,
    });
    renderAt('/');
    // Not a dead end: the page says to choose, and the header offers the choice.
    expect(await screen.findByText(tr.shell.chooseWorkspace)).toBeInTheDocument();
    const switcher = screen.getByRole('combobox', { name: tr.shell.switchWorkspace });
    await user.click(switcher);
    await user.click(await screen.findByRole('option', { name: 'Alfa Atölye' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ workspace_id: WS_ID }),
    );
    expect(await screen.findByText(tr.shell.switched)).toBeInTheDocument();
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
