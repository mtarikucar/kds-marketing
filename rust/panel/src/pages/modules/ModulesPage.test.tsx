import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Blueprint, ModulesOut, WorkspaceModule } from '@/api/modules';
import { agents, capabilities, me, repMe } from '@/test/fixtures';
import { coreModules, legacyModules } from '@/test/modules';
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

  it('shows each agent compactly with its recorded contact and assigned modules, never an online claim', async () => {
    const assigned = { ...module, config: { ...module.config, agent_ids: [agents[0].id] } };
    mockFetch(answers({ 'GET /api/workspace/modules': registry([assigned]) }));
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Ajan merkezi', level: 1 })).toBeInTheDocument();
    const strip = screen.getByRole('region', { name: /Ajanlar/ });
    const row = await within(strip).findByText('ornek-istemci');
    expect(row.closest('li')).toHaveTextContent(/son temas/);
    expect(row.closest('li')).toHaveTextContent(blueprint.name);
    expect(within(strip).getByRole('link', { name: 'Ajan bağla' })).toHaveAttribute('href', '/api-keys');
    expect(screen.queryByText('Çevrimiçi')).not.toBeInTheDocument();
    expect(screen.queryByText('çalışıyor')).not.toBeInTheDocument();
    // Modules live in the navigation now, not on the home page.
    expect(screen.queryByRole('heading', { name: 'İş modülleri' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ortak temel' })).not.toBeInTheDocument();
  });

  it('puts pending work before the log, in plain words with who did it and in which module', async () => {
    const at = new Date().toISOString();
    mockFetch(answers({
      'GET /api/work/pending': { strategy: 'missing', agent: { last_seen_at: null, interval_minutes: 60, overdue: false },
        items: [{ kind: 'approve_strategy', priority: 1, hint: '' }] },
      'GET /api/ledger': [{ id: 7, entry: { workspace_id: me.current_workspace, at, actor: { kind: 'human', user_id: me.user_id },
        action: 'strategy.start_consultation', subject: null, payload: null, strategy_version_id: null } }],
    }));
    renderAt('/');
    const feed = await screen.findByRole('region', { name: /İşler ve onaylar/ });
    const pending = await within(feed).findByRole('list', { name: 'Bekleyen' });
    expect(within(pending).getByRole('link', { name: 'Aç' })).toHaveAttribute('href', '/strategy');
    const log = await within(feed).findByRole('list', { name: 'Günlük' });
    expect(log).toHaveTextContent('Sen strateji istişaresini başlattı');
    expect(log).toHaveTextContent('Strateji');
    expect(pending.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('calendars every visible module’s actions with module, who, when and status', async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60_000);
    if (later.getDate() !== now.getDate()) later.setTime(now.getTime() - 60 * 60_000);
    const planned = new Date(now.getTime() + 2 * 60 * 60_000);
    if (planned.getDate() !== now.getDate()) planned.setTime(now.getTime() - 2 * 60 * 60_000);
    const social = legacyModules.modules.find(m => m.blueprint.id === 'social')!;
    const studioAgent = { ...social, config: { ...social.config, agent_ids: [agents[0].id] } };
    const calls = mockFetch(answers({
      'GET /api/workspace/modules': { ...legacyModules, modules: legacyModules.modules.map(m => m.blueprint.id === 'social' ? studioAgent : m) },
      'GET /api/inbox/tasks': [{ id: 't1', workspace_id: me.current_workspace, journey_id: 'j1', title: 'Teklifi ara', due_at: later.toISOString(), assignee: null, status: 'open' }],
      'GET /api/studio/summary': { week_start: '', tz: 'Europe/Istanbul', from: '', until: '', published: [], cancelled: [], scores: [],
        planned: [{ slot_id: 's1', capability_id: 'c1', format: 'reel', publish_at: planned.toISOString(), prep_start_at: planned.toISOString(), state: 'planned' }] },
    }));
    renderAt('/');
    const calendar = await screen.findByRole('region', { name: /Takvim/ });
    const task = await within(calendar).findByRole('link', { name: /Teklifi ara/ });
    expect(task).toHaveAttribute('href', '/inbox?task=t1');
    expect(task).toHaveTextContent('Atanmamış');
    const post = await within(calendar).findByRole('link', { name: /Reels/ });
    expect(post).toHaveTextContent('ornek-istemci');
    expect(post).toHaveAttribute('href', '/social?slot=s1');
    expect(within(calendar).getByText('Sosyal medya yönetimi')).toBeInTheDocument();
    expect(calls.some(call => call.path === '/api/studio/summary')).toBe(true);
    expect(calls.some(call => call.path === '/api/calls')).toBe(true);
  });

  it('asks nothing of a module that is not installed', async () => {
    const calls = mockFetch(answers());
    renderAt('/');
    await screen.findByRole('region', { name: /Takvim/ });
    await screen.findByRole('link', { name: blueprint.name });
    expect(calls.some(call => ['/api/inbox/tasks', '/api/studio/summary', '/api/calls', '/api/outreach/campaigns'].includes(call.path))).toBe(false);
  });

  it('locks the inbox until a messaging channel is connected, without asking the inbox anything', async () => {
    const locked = { ...registry(), modules: registry().modules.map(m => m.blueprint.id === 'inbox' ? { ...m, installed: true } : m), availability: { inbox: { ready: false, missing: ['messaging'] }, strategy: { ready: true, missing: [] } } };
    const calls = mockFetch(answers({ 'GET /api/workspace/modules': locked }));
    renderAt('/inbox');
    expect(await screen.findByRole('heading', { name: 'Gelen kutusu için bir yetenek bağlanmalı', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('module-missing')).toHaveTextContent('Mesajlaşma');
    expect(screen.getByRole('link', { name: 'Yetenek bağla' })).toHaveAttribute('href', '/connect');
    expect(screen.getAllByLabelText('Kilitli: gerekli yetenek bağlı değil').length).toBeGreaterThan(0);
    expect(calls.some(call => call.path.startsWith('/api/inbox/'))).toBe(false);
  });

  it('names an either-or requirement in words and marks whether it is connected', async () => {
    const outreach = { ...legacyModules.modules.find(m => m.blueprint.id === 'outreach')!, blueprint: { ...legacyModules.modules.find(m => m.blueprint.id === 'outreach')!.blueprint, requirements: ['mailbox|sms_line|whatsapp_cloud', 'Serbest not'] } };
    const data = { ...legacyModules, modules: legacyModules.modules.map(m => m.blueprint.id === 'outreach' ? outreach : m), availability: { outreach: { ready: false, missing: ['mailbox|sms_line|whatsapp_cloud'] } } };
    mockFetch(answers({ 'GET /api/workspace/modules': data }));
    renderAt('/modules/outreach');
    const label = await screen.findByText('E-posta kutusu, SMS hattı veya WhatsApp Business');
    expect(label.closest('li')?.querySelector('[aria-label="Bağlı değil"]')).not.toBeNull();
    expect(screen.getByText('Serbest not').closest('li')?.querySelector('[aria-label]')).toBeNull();
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

  it('chooses a custom blueprint’s requirements from capability groups and kinds, not free text', async () => {
    const user = userEvent.setup();
    const custom = { ...blueprint, id: 'kargo-takibi', name: 'Kargo takibi', description: '', workflow: [], requirements: ['messaging', 'sms_line'] };
    const calls = mockFetch(answers({ 'PUT /api/workspace/modules/kargo-takibi': registry([{ ...module, blueprint: custom }]) }));
    renderAt('/modules');
    await user.click(await screen.findByRole('button', { name: 'Blueprint oluştur' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Modül adı'), 'Kargo takibi');
    await user.click(within(dialog).getByText('İş akışı · Gereken yetenekler'));
    await user.click(within(dialog).getByRole('button', { name: 'Mesajlaşma' }));
    expect(within(dialog).getByRole('button', { name: 'Mesajlaşma' })).toHaveAttribute('aria-pressed', 'true');
    await user.selectOptions(within(dialog).getByLabelText('Belirli bir tür ekle'), 'sms_line');
    const chosen = within(dialog).getByRole('list', { name: 'Seçilen gereksinimler' });
    expect(chosen).toHaveTextContent('Mesajlaşma');
    expect(chosen).toHaveTextContent('SMS hattı');
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur ve ekle' }));
    await waitFor(() => expect(calls.find(call => call.method === 'PUT')?.body).toEqual({ blueprint: { ...custom, version: '1.0.0', builtin: false } }));
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
