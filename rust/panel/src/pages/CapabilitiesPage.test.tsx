import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { EFFECTIVE_STATUSES } from '@/api/types';
import { budgetItems, capabilities, groups, me } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

const routes = {
  'GET /api/auth/me': me,
  'GET /api/capabilities': capabilities,
  'GET /api/capability-groups': groups,
  'GET /api/budget/items': budgetItems,
};

describe('CapabilitiesPage', () => {
  it('shows each capability as a card with its effective status', async () => {
    mockFetch(routes);
    const { container } = renderAt('/capabilities');
    expect(await screen.findByRole('heading', { level: 1, name: tr.capabilities.title })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Atölye Instagram' })).toBeInTheDocument();
    for (const status of EFFECTIVE_STATUSES) {
      expect(screen.getAllByText(tr.status.capability[status]).length).toBeGreaterThan(0);
    }
    const shown = [...container.querySelectorAll('[data-capability-status]')].map((el) =>
      el.getAttribute('data-capability-status'),
    );
    expect(new Set(shown)).toEqual(new Set(EFFECTIVE_STATUSES));
    // Links and groups are named, not shown as ids.
    expect(screen.getAllByText('Saha giderleri').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Marka A').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: tr.capabilities.declare })).toBeInTheDocument();
  });

  it('filters by kind group with the known query parameter', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(routes);
    renderAt('/capabilities');
    await user.click(await screen.findByRole('button', { name: tr.capabilities.groups.device }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/capabilities' && c.search === '?group=device')).toBe(true),
    );
  });
});
