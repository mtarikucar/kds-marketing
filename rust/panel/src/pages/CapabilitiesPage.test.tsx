import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

  it('edits a capability, sending only what changed', async () => {
    const user = userEvent.setup();
    const phone = capabilities[1];
    const id = phone.capability.id;
    const calls = mockFetch({
      ...routes,
      [`PATCH /api/capabilities/${id}`]: {
        capability: { ...phone.capability, name: 'Saha telefonu 2', description: 'Kampanya' },
        effective_status: phone.effective_status,
        verification_reset: false,
      },
    });
    renderAt('/capabilities');
    const card = (await screen.findByRole('heading', { name: 'Saha telefonu' })).closest(
      '[data-capability-id]',
    ) as HTMLElement;
    await user.click(within(card).getByRole('button', { name: tr.capabilities.actions.edit }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(tr.fields.name, { exact: false });
    expect(name).toHaveValue('Saha telefonu');
    // Nothing changed yet: nothing to save. A device's account change resets nothing.
    const save = within(dialog).getByRole('button', { name: tr.common.save });
    expect(save).toBeDisabled();
    expect(within(dialog).queryByText(tr.capabilities.editDialog.connectorWarning)).not.toBeInTheDocument();
    await user.clear(name);
    await user.type(name, '  Saha telefonu 2 ');
    await user.type(within(dialog).getByLabelText(tr.fields.description, { exact: false }), 'Kampanya');
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        name: 'Saha telefonu 2',
        description: 'Kampanya',
      }),
    );
    expect(await screen.findByText(tr.capabilities.editDialog.saved)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it("warns that a connector's new account resets its verification and drops its credentials", async () => {
    const user = userEvent.setup();
    const inbox = {
      ...capabilities[3],
      capability: { ...capabilities[3].capability, external_id: 'destek@acme.example' },
    };
    const id = inbox.capability.id;
    const calls = mockFetch({
      ...routes,
      'GET /api/capabilities': capabilities.map((c) => (c.capability.id === id ? inbox : c)),
      [`PATCH /api/capabilities/${id}`]: {
        capability: { ...inbox.capability, external_id: 'yardim@acme.example', status: 'declared' },
        effective_status: 'declared',
        verification_reset: true,
      },
    });
    renderAt('/capabilities');
    const card = (await screen.findByRole('heading', { name: 'Destek kutusu' })).closest(
      '[data-capability-id]',
    ) as HTMLElement;
    await user.click(within(card).getByRole('button', { name: tr.capabilities.actions.edit }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(tr.capabilities.editDialog.connectorWarning)).toBeInTheDocument();
    const account = within(dialog).getByLabelText(tr.fields.external_id, { exact: false });
    expect(account).toHaveValue('destek@acme.example');
    await user.clear(account);
    await user.type(account, 'yardim@acme.example');
    await user.click(within(dialog).getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ external_id: 'yardim@acme.example' }),
    );
    // The answer says the verification was reset; the panel says so too.
    expect(await screen.findByText(tr.capabilities.editDialog.savedReset)).toBeInTheDocument();
  });

  it('offers no edit on a retired capability', async () => {
    mockFetch(routes);
    renderAt('/capabilities');
    const card = (await screen.findByRole('heading', { name: 'Eski hat' })).closest(
      '[data-capability-id]',
    ) as HTMLElement;
    expect(within(card).queryByRole('button', { name: tr.capabilities.actions.edit })).not.toBeInTheDocument();
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
