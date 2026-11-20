import { expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { contentFetch } from '@/test/content';
import { renderAt } from '@/test/render';
import { legacyModules } from '@/test/modules';
import { agents, budgetItems } from '@/test/fixtures';
import { emptyKnowledge, knowledge } from '@/test/knowledge';

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

it('says an empty knowledge base: nothing is posted or spent until a card has text', async () => {
  contentFetch({ answers: { 'GET /api/knowledge': emptyKnowledge } });
  renderAt('/social');
  expect(await screen.findByRole('link', { name: 'Bilgi bankası boş: ajanlar paylaşım hazırlayamaz.' }, { timeout: 5000 })).toHaveAttribute('href', '/knowledge');
});
it('explains a missing ad budget in Kurallar and in Bütçe only in ads', async () => {
  contentFetch({ answers: { 'GET /api/budget/items': [], 'GET /api/knowledge': { ...knowledge, rules: { ...knowledge.rules, ad_cap: null } } } });
  renderAt('/ads');
  expect(await screen.findByRole('link', { name: "Kurallar'da reklam bütçesi yok." }, { timeout: 5000 })).toHaveAttribute('href', '/knowledge#kurallar');
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
  const calls = contentFetch({ answers: { 'GET /api/budget/items': budgetItems.map(b => ({ ...b, item: { ...b.item, general: b.item.kind === 'ad_budget' } })) } });
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

it('follows the server’s paid rule: Kurallar’s ad budget above zero, whatever the frame says', async () => {
  const general = budgetItems.map(b => ({ ...b, item: { ...b.item, general: b.item.kind === 'ad_budget' } }));
  const withCap = (amount_minor: number) => ({ ...knowledge, rules: { ...knowledge.rules, ad_cap: { amount_minor, period: 'monthly' as const, currency: 'TRY' } } });
  contentFetch({ answers: { 'GET /api/budget/items': general, 'GET /api/knowledge': withCap(0) } });
  const first = renderAt('/ads');
  expect(await screen.findByRole('link', { name: "Kurallar'da reklam bütçesi yok." }, { timeout: 5000 })).toBeVisible();
  first.unmount();
  const calls = contentFetch({ answers: { 'GET /api/budget/items': general, 'GET /api/knowledge': withCap(1_000_000) } });
  const { client } = renderAt('/ads');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await waitFor(() => expect(calls.some(c => c.path === '/api/knowledge')).toBe(true));
  expect(screen.queryByRole('link', { name: "Kurallar'da reklam bütçesi yok." })).not.toBeInTheDocument();
});

it('has no line of its own in social for the frame’s topics: the knowledge base says what is empty', async () => {
  const calls = contentFetch({});
  const { client } = renderAt('/social');
  await waitFor(() => expect(calls.some(c => c.path === '/api/knowledge')).toBe(true));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.queryByRole('link', { name: /hipotez|Bilgi bankası boş/ })).not.toBeInTheDocument();
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

// With the wake states (`GET /api/agents/wakes`) the page says what will happen to its waiting
// work in one sentence, in place of the check-in's (2026-11-19: the owner asked for two revisions
// and waited an hour).
const none = { state: 'no_agent' } as const;
const wakesWith = (needs: Record<string, unknown>) => ({ agents: [], needs: { content: none, materials: none, social: none, ads: none, research: none, inbox: none, ...needs } });

it('says the agent will be called in seconds, once, in place of the stale check-in', async () => {
  contentFetch({ answers: {
    'GET /api/agents': stale,
    'GET /api/work/pending': pending([{ kind: 'content_area', project_id: 'p1' }, { kind: 'content_area', project_id: 'p2' }]),
    'GET /api/agents/wakes': wakesWith({ content: { state: 'calling', api_key_id: agents[0].api_key_id, due_at: new Date(Date.now() + 40_000).toISOString(), waiting_for: 'settle' } }),
  } });
  renderAt('/content');
  expect(await screen.findByText(/^Ajan (39|40) sn içinde çağrılacak$/, undefined, { timeout: 5000 })).toBeInTheDocument();
  expect(screen.getAllByTestId('agent-wake-line')).toHaveLength(1);
  expect(screen.queryByText(/ajanı bekliyor/)).not.toBeInTheDocument();
});

it('keeps the no-agent sentence when no agent may take the work', async () => {
  contentFetch({ answers: { 'GET /api/agents': [], 'GET /api/agents/wakes': wakesWith({}), 'GET /api/work/pending': { items: [{ kind: 'content_area', project_id: 'p1' }] } } });
  renderAt('/content');
  expect(await screen.findByRole('link', { name: '1 iş ajanı bekliyor; bu modülde çalışabilecek bağlı bir ajan yok.' }, { timeout: 5000 })).toHaveAttribute('href', '/agents');
  expect(screen.queryByTestId('agent-wake-line')).not.toBeInTheDocument();
});

it('says nothing about the agent while nothing waits for it, whatever the wake state', async () => {
  const calls = contentFetch({ answers: {
    'GET /api/work/pending': pending([{ kind: 'reply_due' }]),
    'GET /api/agents/wakes': wakesWith({ content: { state: 'schedule', next_expected_at: null, interval_minutes: 60, has_address: false, failed_at: null, run_now: null } }),
  } });
  renderAt('/content');
  await screen.findByRole('navigation', { name: 'Olaylar' }, { timeout: 5000 });
  await waitFor(() => expect(calls.some(c => c.path === '/api/agents/wakes') && calls.some(c => c.path === '/api/work/pending')).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(screen.queryByTestId('agent-wake-line')).not.toBeInTheDocument();
});
