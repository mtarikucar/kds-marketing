import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModulesOut, WorkspaceModule } from '@/api/modules';
import type { CapabilityOut } from '@/api/types';
import tr from '@/i18n/tr.json';
import { capabilities, connectorHealth, groups, budgetItems, me, repMe } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

const custom: CapabilityOut = {
  ...capabilities[0],
  capability: {
    ...capabilities[0].capability,
    id: '0193a000-0000-7000-8000-0000000000c1',
    kind_key: 'other', key_detail: 'workshop-cad', name: 'Atölye CAD',
    description: 'Parça ölçülerinden teknik çizim üretir.',
    status: 'declared', reach: 'agent', has_sealed_config: false,
  },
  effective_status: 'declared',
};
function module(id: string, name: string, ids: string[], installed = true): WorkspaceModule {
  return { blueprint: { id, name, description: '', version: '1.0', requirements: [], workflow: [], builtin: false },
    installed, required: false, revision: 1, config: { brief: '', agent_ids: [], capability_ids: ids } };
}
const registry: ModulesOut = { modules: [
  module('engineering', 'Ürün geliştirme', [custom.capability.id]),
  module('quality', 'Kalite kontrol', [custom.capability.id]),
  module('old', 'Kaldırılmış modül', [capabilities[0].capability.id], false),
], catalog: [] };
const routes = {
  'GET /api/auth/me': me,
  'GET /api/workspace/modules': registry,
  'GET /api/capabilities': [...capabilities, custom],
  'GET /api/capability-groups': groups,
  'GET /api/budget/items': budgetItems,
  'GET /api/connectors/health': connectorHealth,
};

describe('extensible ability inventory', () => {
  it('records a custom ability with its own identifier without inventing an adapter connection', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...routes, 'POST /api/capabilities': custom });
    renderAt('/capabilities');
    await user.click(await screen.findByRole('button', { name: 'Yetenek ekle' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Özel yetenek tanımla/ }));
    const form = within(await screen.findByRole('dialog'));
    expect(form.getByRole('heading', { name: 'Özel yetenek tanımla' })).toBeInTheDocument();
    expect(form.getByText(/Çalıştırma, bu yeteneği kullanabilen bağlı ajan/)).toBeInTheDocument();
    // Paste exercises the actual form inputs without rendering the entire app once per letter.
    // This test checks validation and persistence, not individual keyboard events.
    await user.click(form.getByRole('textbox', { name: /Görünen ad/ }));
    await user.paste('Renk ölçümü');
    const submit = form.getByRole('button', { name: tr.capabilities.declareDialog.submit });
    expect(submit).toBeDisabled();
    await user.click(form.getByRole('textbox', { name: /Yetenek kimliği/ }));
    await user.paste('invalid.identifier');
    expect(submit).toBeDisabled();
    await user.clear(form.getByRole('textbox', { name: /Yetenek kimliği/ }));
    await user.paste('quality-spectrometer');
    await user.click(form.getByRole('textbox', { name: /Ne yapabilir/ }));
    await user.paste('USB ölçüm cihazından renk değerini okur.');
    await user.click(submit);
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toEqual([
      expect.objectContaining({ path: '/api/capabilities', body: {
        kind_key: 'other', key_detail: 'quality-spectrometer', name: 'Renk ölçümü',
        description: 'USB ölçüm cihazından renk değerini okur.',
      } }),
    ]));
    expect(calls.some(call => call.path.includes('/connectors/') && call.method !== 'GET')).toBe(false);
  });

  it('filters custom abilities and searches their stable identifier', async () => {
    const user = userEvent.setup();
    mockFetch(routes);
    renderAt('/capabilities');
    await screen.findByRole('heading', { name: custom.capability.name });
    await user.click(screen.getByRole('button', { name: 'Özel yetenekler' }));
    expect(screen.getByRole('heading', { name: custom.capability.name })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Atölye Instagram' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: tr.capabilities.workbench.search }), 'workshop-cad');
    expect(screen.getByRole('heading', { name: custom.capability.name })).toBeInTheDocument();
  });

  it('shows shared module usage and ignores removed module bindings', async () => {
    const user = userEvent.setup();
    mockFetch(routes);
    renderAt('/capabilities');
    const card = (await screen.findByRole('heading', { name: custom.capability.name })).closest('[data-capability-id]') as HTMLElement;
    expect(within(card).getByRole('link', { name: 'Ürün geliştirme' })).toHaveAttribute('href', '/modules/engineering');
    expect(within(card).getByRole('link', { name: 'Kalite kontrol' })).toHaveAttribute('href', '/modules/quality');
    const selector = screen.getByRole('combobox', { name: 'Kullanan modül' });
    expect(within(selector).queryByRole('option', { name: 'Kaldırılmış modül' })).not.toBeInTheDocument();
    await user.selectOptions(selector, 'engineering');
    expect(screen.queryByRole('heading', { name: 'Atölye Instagram' })).not.toBeInTheDocument();
    await user.selectOptions(selector, 'unassigned');
    expect(screen.queryByRole('heading', { name: custom.capability.name })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Atölye Instagram' })).toBeInTheDocument();
  });

  it('allows read-only discovery while hiding all ability creation controls', async () => {
    mockFetch({ ...routes, 'GET /api/auth/me': repMe });
    renderAt('/capabilities?goal=custom');
    expect(await screen.findByRole('heading', { name: custom.capability.name })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yetenek ekle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Özel yetenek tanımla' })).not.toBeInTheDocument();
  });

  it('brings phones and computer access into the same device view', async () => {
    const user = userEvent.setup();
    const computerAccess: CapabilityOut = { ...custom, capability: {
      ...custom.capability, id: '0193a000-0000-7000-8000-0000000000c2',
      kind_key: 'shell', key_detail: null, name: 'Atölye bilgisayarı erişimi',
    } };
    mockFetch({ ...routes, 'GET /api/capabilities': [...capabilities, computerAccess] });
    renderAt('/capabilities');
    await user.click(await screen.findByRole('button', { name: 'Yetenek ekle' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Telefon veya cihaz/ }));
    expect(await screen.findByRole('heading', { name: 'Saha telefonu' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: computerAccess.capability.name })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Atölye Instagram' })).not.toBeInTheDocument();
  });
});
