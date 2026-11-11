import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import en from '@/i18n/en.json';
import { flatten } from '@/i18n/flatten';
import { PERMISSIONS, type MeOut } from '@/api/types';
import { WS_ID, me, workspace } from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { coreModules, legacyModules } from '@/test/modules';

const NO_SESSION = withStatus(401, { code: 'UNAUTHENTICATED', message: 'no session', details: {} });

describe('Shell', () => {
  it('shows the menu, the workspace and its status in Turkish by default', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace });
    renderAt('/');
    const nav = (await screen.findAllByRole('navigation', { name: tr.nav.label }))[0];
    await userEvent.click(within(nav).getByText('Yönetim'));
    for (const label of [
      tr.nav.home,
      tr.nav.strategy,
      tr.nav.capabilities,
      tr.nav.budget,
      tr.nav.users,
      tr.nav.apiKeys,
      tr.nav.agents,
    ]) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getAllByText('Alfa Atölye').length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe('tr');
  });

  it('opens the navigation drawer, follows a link and dismisses the drawer', async () => {
    const user = userEvent.setup();
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace });
    const { router } = renderAt('/');
    await user.click(await screen.findByRole('button', { name: tr.nav.label }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('link', { name: tr.nav.inbox })).toHaveAttribute('href', '/inbox');
    await user.click(await within(drawer).findByRole('link', { name: tr.nav.people }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/people'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

  it('nav_lists_new_pages_for_permitted_users', async () => {
    const permitted: MeOut = {
      ...me,
      memberships: [
        {
          ...me.memberships[0],
          permissions: [...me.memberships[0].permissions, 'prospects.work', 'outreach.work'],
        },
      ],
    };
    mockFetch({ 'GET /api/auth/me': permitted, 'GET /api/workspace': workspace });
    const first = renderAt('/');
    const nav = (await screen.findAllByRole('navigation', { name: tr.nav.label }))[0];
    expect(await within(nav).findByRole('link', { name: tr.nav.prospects })).toHaveAttribute('href', '/prospects');
    expect(within(nav).getByRole('link', { name: tr.nav.outreach })).toHaveAttribute('href', '/outreach');
    first.unmount();

    // Without the permissions the pages are not offered (the server refuses them anyway).
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace });
    renderAt('/');
    const plain = (await screen.findAllByRole('navigation', { name: tr.nav.label }))[0];
    expect(within(plain).getByRole('link', { name: tr.nav.home })).toBeInTheDocument();
    expect(within(plain).queryByRole('link', { name: tr.nav.prospects })).not.toBeInTheDocument();
    expect(within(plain).queryByRole('link', { name: tr.nav.outreach })).not.toBeInTheDocument();
  });

  it('keeps core modules and the add action while hiding optional modules in a new workspace', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace/modules': coreModules });
    renderAt('/');
    const nav = (await screen.findAllByRole('navigation', { name: tr.nav.label }))[0];
    expect(within(nav).queryByRole('link', { name: tr.nav.inbox })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: tr.nav.strategy })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Modül ekle' })).toHaveAttribute('href', '/modules');
    expect(within(nav).queryByRole('link', { name: tr.nav.studio })).not.toBeInTheDocument();
  });

  it('adds arbitrary installed blueprints to navigation without accepting external paths', async () => {
    const custom = { ...legacyModules.modules[0], required: false, blueprint: {
      id: 'quality-control', name: 'Kalite kontrol', description: '', version: '1', requirements: [], workflow: [], builtin: false,
    } };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace/modules': { ...coreModules, modules: [...coreModules.modules, custom] } });
    renderAt('/');
    const nav = (await screen.findAllByRole('navigation', { name: tr.nav.label }))[0];
    expect(await within(nav).findByRole('link', { name: 'Kalite kontrol' })).toHaveAttribute('href', '/modules/quality-control');
  });

  it('blocks direct navigation to an uninstalled optional screen without fetching its business data', async () => {
    const calls = mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace/modules': coreModules });
    renderAt('/studio');
    expect(await screen.findByRole('heading', { name: 'Bu modül çalışma alanına eklenmemiş' })).toBeInTheDocument();
    expect(calls.some(c => c.path.startsWith('/api/studio/'))).toBe(false);
    expect(screen.getByRole('link', { name: 'Modülü incele' })).toHaveAttribute('href', '/modules/social');
  });

  it('permissions_copy_parity', () => {
    for (const key of ['prospects.work', 'prospects.manage', 'outreach.work', 'outreach.manage']) {
      expect(PERMISSIONS).toContain(key);
    }
    const trFlat = flatten(tr);
    const enFlat = flatten(en);
    for (const permission of PERMISSIONS) {
      expect(trFlat[`permissions.${permission}`], permission).toBeTruthy();
      expect(enFlat[`permissions.${permission}`], permission).toBeTruthy();
    }
    expect(en.nav.prospects).toBe('Prospects');
    expect(en.nav.outreach).toBe('Campaigns');
    expect(tr.nav.prospects).toBe('Aday havuzu');
    expect(tr.nav.outreach).toBe('Kampanyalar');
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

it('orders core, installed modules including inbox, then management without removed pages', async () => {
  mockFetch({ 'GET /api/auth/me': { ...me, memberships: [{ ...me.memberships[0], permissions: [...PERMISSIONS] }] } });
  renderAt('/');
  const nav = (await screen.findAllByRole('navigation', { name: tr.nav.label }))[0];
  await within(nav).findByRole('link', { name: 'Materyal kütüphanesi' });
  await userEvent.click(within(nav).getByText('Yönetim'));
  expect(within(nav).getAllByRole('link').map(a => a.getAttribute('href'))).toEqual([
    '/', '/strategy', '/inbox', '/content', '/social', '/ads', '/materials', '/people', '/prospects', '/outreach', '/calls', '/modules',
    '/budget', '/users', '/api-keys', '/capabilities', '/agents',
  ]);
  expect(within(nav).queryByText('İş takibi')).not.toBeInTheDocument();
  expect(within(nav).queryByText('Günlük')).not.toBeInTheDocument();
});

it.each(['materials', 'content', 'social', 'ads'])('gates the %s module before any business query', async module => {
  const calls = mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace/modules': coreModules });
  renderAt(`/${module}`);
  expect(await screen.findByRole('heading', { name: 'Bu modül çalışma alanına eklenmemiş' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Modülü incele' })).toHaveAttribute('href', `/modules/${module}`);
  expect(calls.some(c => c.path.startsWith('/api/studio/'))).toBe(false);
});

it('offers a module installation link when a read reports MODULE_NOT_INSTALLED', async () => {
  mockFetch({ 'GET /api/auth/me': me, 'GET /api/budget/items': withStatus(409, { code: 'MODULE_NOT_INSTALLED', message: 'removed', details: { module: 'ads' } }) });
  renderAt('/budget');
  expect(await screen.findByRole('link', { name: 'Modülü incele' })).toHaveAttribute('href', '/modules/ads');
  expect(screen.getByText(tr.gates.moduleBody)).toBeVisible();
});
