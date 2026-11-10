import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Blueprint, ModulesOut, WorkspaceModule } from '@/api/modules';
import { agents, capabilities, me, repMe } from '@/test/fixtures';
import { coreModules } from '@/test/modules';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { parseBlueprint, portableBlueprint } from '@/lib/modules';

const blueprint: Blueprint = {
  id: 'field-research', name: 'Saha araştırması', description: 'Sahadan gelen kayıtları incele ve raporla.',
  version: '1.0.0', requirements: ['phone-control', 'research-sensor'], workflow: ['Kaydı al', 'Bulguları incele'], builtin: false,
};
const module: WorkspaceModule = {
  blueprint, installed: true, required: false, revision: 4,
  config: { brief: 'Saha verilerini incele.', agent_ids: [], capability_ids: [] },
};
function registry(extra: WorkspaceModule[] = [module]): ModulesOut { return { modules: [...coreModules.modules, ...extra], catalog: [...coreModules.modules.map(m => m.blueprint), blueprint] }; }
const activeMe = { ...me, memberships: me.memberships.map(m => ({ ...m, workspace_status: 'active' as const })) };
function answers(extra: Record<string, unknown> = {}) {
  return { 'GET /api/auth/me': activeMe, 'GET /api/workspace/modules': registry(), 'GET /api/agents': agents, 'GET /api/capabilities': capabilities, ...extra };
}

describe('modular agent center', () => {
  it('explains activation and does not fetch agents for an inactive workspace', async () => {
    const calls = mockFetch(answers({ 'GET /api/auth/me': me }));
    renderAt('/');
    expect(await screen.findByText('Çalışma alanı etkin olduğunda ajan bağlantıları görüntülenir ve modüller düzenlenebilir.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Hesap durumunu incele' })).toHaveAttribute('href', '/billing');
    expect(calls.some(call => call.path === '/api/agents')).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses recorded connections and explicit assignments to focus the modules', async () => {
    const user = userEvent.setup();
    const assigned = { ...module, config: { ...module.config, agent_ids: [agents[0].id] } };
    mockFetch(answers({ 'GET /api/workspace/modules': registry([assigned]) }));
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Ajan merkezi', level: 1 })).toBeInTheDocument();
    const agentsSection = await screen.findByRole('region', { name: 'Ajan bağlantıları' });
    const choice = await within(agentsSection).findByRole('button', { name: /ornek-istemci/ });
    expect(choice).toHaveTextContent('Son temas');
    expect(screen.queryByText('Çevrimiçi')).not.toBeInTheDocument();
    await user.click(choice);
    const section = screen.getByRole('region', { name: 'Bu ajanın modülleri' });
    expect(within(section).getByRole('heading', { name: blueprint.name })).toBeInTheDocument();
    expect(within(section).queryByRole('heading', { name: 'Büyüme stüdyosu' })).not.toBeInTheDocument();
  });

  it('creates an arbitrary blueprint and navigates to its actual persisted module', async () => {
    const user = userEvent.setup();
    const custom = { ...blueprint, id: 'orchard', name: 'Bahçe takibi', description: 'Sensör kayıtlarını işle.', workflow: [], requirements: [] };
    const routes = answers({ 'PUT /api/workspace/modules/orchard': registry([{ ...module, blueprint: custom }]) });
    const calls = mockFetch(routes);
    const { router } = renderAt('/modules');
    await user.click(await screen.findByRole('button', { name: 'Blueprint oluştur' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Modül adı'), custom.name);
    await user.clear(within(dialog).getByLabelText('Blueprint kimliği'));
    await user.type(within(dialog).getByLabelText('Blueprint kimliği'), custom.id);
    await user.type(within(dialog).getByLabelText('Ne için kullanılacak?'), custom.description);
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur ve ekle' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/modules/orchard'));
    const write = calls.find(call => call.method === 'PUT');
    expect(write?.path).toBe('/api/workspace/modules/orchard');
    expect(write?.body).toEqual({ blueprint: custom });
    expect(calls.filter(call => ['POST', 'DELETE', 'PATCH'].includes(call.method))).toHaveLength(0);
  });

  it('persists an agent and a reusable capability binding with the revision stamp', async () => {
    const user = userEvent.setup();
    const next = { ...module, revision: 5, config: { brief: 'Yeni talimat', agent_ids: [agents[0].id], capability_ids: [capabilities[0].capability.id] } };
    const calls = mockFetch(answers({ 'PATCH /api/workspace/modules/field-research': registry([next]) }));
    renderAt('/modules/field-research');
    await user.click(await screen.findByRole('button', { name: 'Ajanlar ve yetenekler' }));
    const brief = screen.getByLabelText('Çalışma talimatı');
    await user.clear(brief); await user.type(brief, 'Yeni talimat');
    await user.click(await screen.findByRole('checkbox', { name: /ornek-istemci/ }));
    await user.click(screen.getByRole('checkbox', { name: new RegExp(capabilities[0].capability.name) }));
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ config: next.config, revision: 4 }));
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });

  it('keeps a stale edit visible when the server rejects its revision', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ 'PATCH /api/workspace/modules/field-research': withStatus(409, { code: 'CONFLICT', message: 'revision changed', details: {} }) }));
    renderAt('/modules/field-research');
    await user.click(await screen.findByRole('button', { name: 'Ajanlar ve yetenekler' }));
    await user.type(screen.getByLabelText('Çalışma talimatı'), ' Taslak korunacak.');
    await user.click(await screen.findByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Çalışma talimatı')).toHaveValue('Saha verilerini incele. Taslak korunacak.');
  });

  it('requires confirmation to remove an optional module and never deletes its capabilities', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(answers({ 'DELETE /api/workspace/modules/field-research': registry([{ ...module, installed: false }]) }));
    const { router } = renderAt('/modules/field-research');
    await user.click(await screen.findByRole('button', { name: 'Modülü kaldır' }));
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('silinmez');
    await user.click(within(dialog).getByRole('button', { name: 'Modülü kaldır' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/modules'));
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual(['/api/workspace/modules/field-research']);
  });

  it('does not offer removal for required modules', async () => {
    mockFetch(answers());
    renderAt('/modules/inbox');
    expect(await screen.findByRole('heading', { name: 'Gelen kutusu', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Modülü kaldır' })).not.toBeInTheDocument();
  });

  it('does not offer mutation controls without capability management permission', async () => {
    mockFetch(answers({ 'GET /api/auth/me': { ...repMe, memberships: repMe.memberships.map(m => ({ ...m, workspace_status: 'active' })) } }));
    renderAt('/modules');
    await screen.findByRole('heading', { name: 'Blueprint kataloğu' });
    expect(screen.queryByRole('button', { name: 'Blueprint oluştur' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ekle' })).not.toBeInTheDocument();
  });
});

describe('portable blueprint boundary', () => {
  it('accepts arbitrary declarative requirements while rejecting URLs, code, bindings and built-in overrides', () => {
    const portable = portableBlueprint(blueprint);
    expect(parseBlueprint(portable)).toEqual(blueprint);
    for (const extra of [{ route: 'https://example.com' }, { script: 'alert(1)' }, { agent_ids: [agents[0].id] }, { builtin: true }]) {
      expect(parseBlueprint({ ...portable, ...extra })).toBeNull();
    }
    expect(parseBlueprint({ ...portable, id: '../inbox' })).toBeNull();
  });
});
