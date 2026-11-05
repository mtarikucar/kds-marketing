import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import {
  capabilities,
  connectorHealth,
  groups,
  budgetItems,
  me,
  repMe,
  lostPage,
  hooks,
} from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';
const routes = {
  'GET /api/auth/me': me,
  'GET /api/capabilities': [...capabilities, lostPage],
  'GET /api/capability-groups': groups,
  'GET /api/budget/items': budgetItems,
  'GET /api/connectors/health': connectorHealth,
  'GET /api/connectors/hooks': hooks,
};
const copy = tr.capabilities.workbench;
describe('purpose-driven connections', () => {
  it('narrows by purpose and opens the matching connector, preserving browser navigation', async () => {
    const user = userEvent.setup();
    mockFetch(routes);
    const { router } = renderAt('/capabilities');
    await screen.findByRole('heading', { name: 'Atölye Instagram' });
    await user.click(screen.getByRole('button', { name: copy.goals.publishing.label }));
    expect(router.state.location.search).toBe('?goal=publishing');
    expect(screen.queryByRole('heading', { name: 'Destek kutusu' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: new RegExp(copy.addForPurpose) }));
    expect(screen.getByRole('link', { name: 'Instagram' })).toHaveAttribute(
      'href',
      '/connect?kind=instagram',
    );
    await user.click(screen.getByRole('button', { name: copy.clear }));
    expect(await screen.findByRole('heading', { name: 'Destek kutusu' })).toBeInTheDocument();
  });
  it('combines search and status, and resets an empty result', async () => {
    const user = userEvent.setup();
    mockFetch(routes);
    renderAt('/capabilities');
    await screen.findByRole('heading', { name: 'Atölye Instagram' });
    await user.selectOptions(screen.getByRole('combobox', { name: copy.statusLabel }), 'attention');
    expect(screen.getByRole('heading', { name: 'Atölye Instagram' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Eski hat' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: copy.search }), 'no-such-account');
    expect(await screen.findByText(copy.noMatch)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.clear }));
    expect(screen.getByRole('textbox', { name: copy.search })).toHaveValue('');
    expect(await screen.findByRole('heading', { name: 'Atölye Instagram' })).toBeInTheDocument();
  });
  it('keeps technical data unrequested until its tab opens and hides it from representatives', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes);
    const view = renderAt('/capabilities');
    await screen.findByRole('heading', { name: 'Atölye Instagram' });
    expect(calls.some((c) => c.path === '/api/connectors/hooks')).toBe(false);
    await user.click(screen.getByRole('tab', { name: copy.technicalTab }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/connectors/hooks')).toBe(true));
    view.unmount();
    mockFetch({ ...routes, 'GET /api/auth/me': repMe });
    renderAt('/capabilities?goal=publishing');
    await screen.findByRole('heading', { name: 'Atölye Instagram' });
    expect(screen.queryByRole('tab', { name: copy.technicalTab })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(copy.addForPurpose) })).not.toBeInTheDocument();
  });
  it('pages long lists and resets the page when searching', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 19 }, (_, i) => ({
      ...capabilities[0],
      capability: {
        ...capabilities[0].capability,
        id: `fixture-${i}`,
        name: `Account ${String(i).padStart(2, '0')}`,
      },
    }));
    mockFetch({ ...routes, 'GET /api/capabilities': many });
    renderAt('/capabilities');
    await screen.findByRole('heading', { name: 'Account 00' });
    expect(screen.queryByRole('heading', { name: 'Account 08' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.next }));
    expect(screen.getByRole('heading', { name: 'Account 08' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: copy.search }), 'Account 00');
    expect(screen.getByRole('heading', { name: 'Account 00' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: copy.pagination })).not.toBeInTheDocument();
  });
  it('offers one setup step instead of empty filters, respecting management permission', async () => {
    mockFetch({ ...routes, 'GET /api/capabilities': [] });
    const view = renderAt('/capabilities');
    expect(await screen.findByRole('link', { name: copy.startConnection })).toHaveAttribute('href', '/connect');
    expect(screen.queryByRole('textbox', { name: copy.search })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: copy.statusLabel })).not.toBeInTheDocument();
    view.unmount();
    mockFetch({ ...routes, 'GET /api/capabilities': [], 'GET /api/auth/me': repMe });
    renderAt('/capabilities');
    expect(await screen.findByText(copy.managerNeeded)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.startConnection })).not.toBeInTheDocument();
  });

});
