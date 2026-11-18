import { expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { contentFetch } from '@/test/content';
import { renderAt } from '@/test/render';
import { legacyModules } from '@/test/modules';
import { agents, strategyWithDraft, budgetItems } from '@/test/fixtures';

it.each([
  ['no connections', [], [], '2 iş ajanı bekliyor; bu modülde çalışabilecek bağlı bir ajan yok.', '/agents'],
  ['missing assignment', ['gone'], agents, '2 iş ajanı bekliyor; bu modülde çalışabilecek bağlı bir ajan yok.', '/modules/content'],
  ['overdue assigned', [agents[0].id], [{ ...agents[0], overdue: true }], /^2 iş ajanı bekliyor; ajan en son .* yoklama yaptı\.$/, '/agents'],
] as const)('explains %s and links the fix', async (_, ids, connections, text, href) => {
  contentFetch({ answers: { 'GET /api/agents': connections, 'GET /api/workspace/modules': { ...legacyModules, modules: legacyModules.modules.map(m => ({ ...m, config: { ...m.config, agent_ids: ids } })) }, 'GET /api/work/pending': { items: [{ kind: 'content_area', project_id: 'p1' }, { kind: 'content_area_held', project_id: 'p2' }, { kind: 'reply_due' }] } } });
  renderAt('/content');
  // The complete router and its dependent reads can exceed one second in the parallel suite.
  expect(await screen.findByRole('link', { name: text }, { timeout: 5000 })).toHaveAttribute('href', href);
});

it('explains a missing approved strategy', async () => {
  contentFetch({ answers: { 'GET /api/strategy': { approved: null, draft: null, gaps: [] } } });
  renderAt('/social');
  expect(await screen.findByRole('link', { name: 'Onaylı strateji yok; hazırlık yapılır, paylaşım ve harcama bekler.' })).toHaveAttribute('href', '/strategy');
});
it('explains missing paid strategy and ad budget only in ads', async () => {
  contentFetch({ answers: { 'GET /api/budget/items': [] } });
  renderAt('/ads');
  expect(await screen.findByRole('link', { name: 'Strateji reklam harcamasına izin vermiyor; kampanyalar bekler.' })).toHaveAttribute('href', '/strategy');
  expect(await screen.findByRole('link', { name: "Bütçe’de reklam bütçesi yok; kampanyalar bekler." })).toHaveAttribute('href', '/budget');
});
it('says when the connected ad account may only be read, and nothing when it may create ads', async () => {
  const account = (scopes: string[]) => ({ capability: { id: 'ad-1', kind_key: 'meta_ads', name: 'Hesap', connector_public: { access: { scopes } } }, effective_status: 'verified' });
  const text = 'Bağlı reklam hesabının reklam oluşturma izni yok (ads_management); kampanyalar kurulamaz. Hesabı yeniden bağlayın ve izin ekranında bu izni verin.';
  contentFetch({ answers: { 'GET /api/capabilities': [account(['ads_read'])] } });
  const first = renderAt('/ads');
  expect(await screen.findByRole('link', { name: text }, { timeout: 5000 })).toHaveAttribute('href', '/capabilities');
  first.unmount();
  const calls = contentFetch({ answers: { 'GET /api/capabilities': [account(['ads_read', 'ads_management'])] } });
  const { client } = renderAt('/ads');
  await waitFor(() => expect(calls.some(c => c.path === '/api/capabilities')).toBe(true));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.queryByRole('link', { name: text })).not.toBeInTheDocument();
});
it('renders nothing when all is well, including an unassigned connected agent', async () => {
  const calls = contentFetch({ answers: { 'GET /api/budget/items': budgetItems.map(b => ({ ...b, item: { ...b.item, general: b.item.kind === 'ad_budget' } })), 'GET /api/strategy': { ...strategyWithDraft, approved: { ...strategyWithDraft.approved, sections: { ...strategyWithDraft.approved!.sections, paid_enabled: true, budget_frame: { lanes: [{ lane: 'paid', period: 'monthly', cap_minor: 1_000_000, currency: 'TRY' }] } } } } } });
  const { client } = renderAt('/ads');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await waitFor(() => expect(calls.some(c => c.path === '/api/budget/items')).toBe(true));
  expect(screen.queryByRole('region', { name: 'Modül durumu' })).not.toBeInTheDocument();
});

it('does not treat a revoked assigned key as an available agent', async () => {
  contentFetch({ answers: {
    'GET /api/api-keys': [{ id: agents[0].api_key_id, status: 'revoked', scopes: ['content.work'] }],
    'GET /api/work/pending': { items: [{ kind: 'content_area', project_id: 'p1' }], agent: { overdue: false, interval_minutes: 60, last_seen_at: null }, strategy: { approved: { number: 3 } } },
    'GET /api/workspace/modules': { ...legacyModules, modules: legacyModules.modules.map(m => ({ ...m, config: { ...m.config, agent_ids: [agents[0].id] } })) },
  } });
  renderAt('/content');
  expect(await screen.findByRole('link', { name: '1 iş ajanı bekliyor; bu modülde çalışabilecek bağlı bir ajan yok.' })).toHaveAttribute('href', '/modules/content');
});

it('follows the server’s paid rule: a paid lane in the ad budget’s currency, whatever the channels', async () => {
  const general = budgetItems.map(b => ({ ...b, item: { ...b.item, general: b.item.kind === 'ad_budget' } }));
  const strategy = (currency: string) => ({ ...strategyWithDraft, approved: { ...strategyWithDraft.approved, sections: { ...strategyWithDraft.approved!.sections, paid_enabled: true, channels: [{ channel: 'any', rationale: '', group_id: null }], budget_frame: { lanes: [{ lane: 'paid', period: 'monthly', cap_minor: 1_000_000, currency }] } } } });
  contentFetch({ answers: { 'GET /api/budget/items': general, 'GET /api/strategy': strategy('USD') } });
  const first = renderAt('/ads');
  expect(await screen.findByRole('link', { name: 'Strateji reklam harcamasına izin vermiyor; kampanyalar bekler.' })).toBeVisible();
  first.unmount();
  const calls = contentFetch({ answers: { 'GET /api/budget/items': general, 'GET /api/strategy': strategy('TRY') } });
  const { client } = renderAt('/ads');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await waitFor(() => expect(calls.some(c => c.path === '/api/budget/items')).toBe(true));
  expect(screen.queryByRole('link', { name: 'Strateji reklam harcamasına izin vermiyor; kampanyalar bekler.' })).not.toBeInTheDocument();
});

it('says in social when no hypothesis of the strategy posts, and nothing when one does', async () => {
  contentFetch({});
  const first = renderAt('/social');
  const row = await screen.findByRole('link', { name: /hiçbir hipotez paylaşım yapmıyor/ });
  expect(row).toHaveAttribute('href', '/strategy');
  first.unmount();
  const posting = { ...strategyWithDraft, approved: { ...strategyWithDraft.approved, hypotheses: strategyWithDraft.approved!.hypotheses.map(h => ({ ...h, cadence: { organic: { slots_per_week: 3, exploration_bps: 0, content_types: [{ key: 'general', min_bps: 0, max_bps: 10000 }] } } })) } };
  const calls = contentFetch({ answers: { 'GET /api/strategy': posting } });
  const { client } = renderAt('/social');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await waitFor(() => expect(calls.some(c => c.path === '/api/strategy')).toBe(true));
  expect(screen.queryByRole('link', { name: /hiçbir hipotez paylaşım yapmıyor/ })).not.toBeInTheDocument();
});

// Sixteen keys that last checked in weeks ago (figurunica, 2026-11-18): one line at most, and
// none while nothing waits for an agent.
const stale = Array.from({ length: 16 }, (_, i) => ({ ...agents[0], id: `agent-${i}`, overdue: true, last_seen_at: `2026-10-${String(26 + (i % 5)).padStart(2, '0')}T09:00:00Z` }));
const pending = (items: unknown[]) => ({ items, agent: { overdue: true, interval_minutes: 60, last_seen_at: '2026-10-30T09:00:00Z' }, strategy: { approved: { number: 3 } } });

it('says nothing of many stale agents while no work waits', async () => {
  const calls = contentFetch({ answers: { 'GET /api/agents': stale, 'GET /api/work/pending': pending([{ kind: 'reply_due' }]) } });
  renderAt('/content');
  await screen.findByRole('navigation', { name: 'Olaylar' }, { timeout: 5000 });
  await waitFor(() => expect(calls.some(c => c.path === '/api/agents') && calls.some(c => c.path === '/api/work/pending')).toBe(true));
  // Both reads answered: give them a turn to render before asserting the absence.
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(screen.queryByText(/yoklama yaptı/)).not.toBeInTheDocument();
  expect(screen.queryByText(/ajanı bekliyor/)).not.toBeInTheDocument();
});

it('names the waiting work and the latest check-in of many stale agents in one line', async () => {
  contentFetch({ answers: { 'GET /api/agents': stale, 'GET /api/work/pending': pending([{ kind: 'content_area', project_id: 'p1' }, { kind: 'studio_material_analysis', material_id: 'm1' }]) } });
  renderAt('/content');
  const lines = await screen.findAllByRole('link', { name: /ajanı bekliyor/ }, { timeout: 5000 });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveTextContent(/^2 iş ajanı bekliyor; ajan en son .*30.* yoklama yaptı\.$/);
});
