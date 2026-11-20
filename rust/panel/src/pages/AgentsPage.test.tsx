import * as clipboard from '@/lib/clipboard';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { LedgerEntryOut, WorkItem } from '@/api/types';
import { me, WS_ID } from '@/test/fixtures';
import { DAY, HOUR, MIN, at, connection, key, routine, wake, wakesOf } from '@/test/agents';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { wakeTime, wakeTimeIn } from '@/lib/wake';
import { AGENT_COPY } from './agents/copy';

// The agents page as the owner reads it: one row per agent (an API key), its state in a sentence,
// "Şimdi çalıştır" and the wake address on the row, the rest opened in place, unused agents
// folded away, counted chips, and connecting an agent with a name and a few plain choices.

// The fixtures below read the clock when the file loads and the expected sentences read it again
// after a render, so the clock stands still at a fixed midday for the whole file: a wake time then
// reads the same `HH:MM` in both, on whatever minute or day the run falls.
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
afterAll(() => {
  vi.useRealTimers();
});

const c = AGENT_COPY.tr;
const without = (...drop: string[]) => ({ ...me, memberships: [{ ...me.memberships[0], permissions: me.memberships[0].permissions.filter((p) => !drop.includes(p)) }] });
const rowOf = async (name: string) => screen.findByRole('article', { name });
const openRow = async (name: string) => {
  const row = await rowOf(name);
  await userEvent.setup().click(within(row).getByRole('button', { name: c.open.replace('{name}', name) }));
  return row;
};

// The owner's agents: a content routine that comes hourly and has a wake address, a research
// agent that comes daily without one, a setup key and a codex key unused for weeks with their
// stale connections, and a key issued yesterday that has not come yet.
const content = key({ name: 'content-routine', prefix: 'jt_live_wYw_', scopes: ['workspace.read', 'materials.work', 'content.work', 'social.work'], created_at: '2026-11-13T12:15:00Z' });
const research = key({ name: 'Aday araştırma', scopes: ['workspace.read', 'prospects.work'] });
const setup = key({ name: 'setup', prefix: 'jt_live_8JDw', scopes: ['workspace.read', 'team.manage', 'api_keys.manage', 'content.work', 'social.work', 'ads.work', 'materials.work', 'prospects.work'] });
const fresh = key({ name: 'Yeni ajan', created_at: at(-DAY), scopes: ['workspace.read', 'inbox.work'] });
const contentConns = [
  connection(content, { client_name: 'content-routine', client_version: '1', last_seen_at: at(-51 * MIN), tool_calls: 343 }),
  connection(content, { client_name: 'c', client_version: '1', last_seen_at: at(-3 * HOUR), tool_calls: 0 }),
  connection(content, { client_name: 'ops', client_version: '1', last_seen_at: at(-2 * DAY), overdue: true }),
];
const setupConns = ['ops', 'check', 'codex-setup', 'claude-code-setup', 'probe'].map((name, i) => connection(setup, { client_name: name, last_seen_at: at(-(8 + i * 4) * DAY), overdue: true }));
const researchConn = connection(research, { client_name: 'codex-mcp-client', client_version: '0.63.0', last_seen_at: at(-5 * HOUR) });
const keys = [content, research, setup, fresh];
const connections = [...contentConns, ...setupConns, researchConn];
const wakes = wakesOf(
  wake(content, { address: routine(), last_seen_at: at(-51 * MIN), next_expected_at: at(9 * MIN), run_now: { api_key_id: content.id, after: null },
    last: { at: at(-3 * HOUR), reasons: ['content_revision'], outcome: 'fired', status: 200, session_id: 's1', session_url: 'https://claude.ai/code/session_1' } }),
  wake(research, { last_seen_at: at(-5 * HOUR), interval_minutes: 1440, next_expected_at: at(19 * HOUR) }),
  wake(setup, { last_seen_at: setupConns[0].last_seen_at, next_expected_at: at(-6 * DAY) }),
  wake(fresh, { last_seen_at: null, next_expected_at: null }),
);
const owner = (over: Record<string, unknown> = {}) => mockFetch({
  'GET /api/auth/me': me, 'GET /api/agents': connections, 'GET /api/api-keys': keys, 'GET /api/agents/wakes': wakes,
  'GET /api/work/pending': { strategy: 'missing', items: [], agent: { last_seen_at: null, interval_minutes: 60, overdue: false } },
  ...over,
});

describe('the agents page', () => {
  it('shows one row per agent with what it does and how it stands, in words', async () => {
    owner();
    renderAt('/agents');
    expect(await screen.findByRole('heading', { level: 1, name: c.title })).toBeInTheDocument();
    const row = await rowOf('content-routine');
    expect(within(row).getByText('İçerik hazırlar, dosyaları inceleyip etiketler ve paylaşımları planlar.')).toBeInTheDocument();
    expect(within(row).getByText(`51 dakika önce uğradı; saat başı uğrar, sıradaki ${wakeTime(at(9 * MIN), 'tr')}.`)).toBeInTheDocument();
    const daily = await rowOf('Aday araştırma');
    expect(within(daily).getByText('Aday araştırır.')).toBeInTheDocument();
    expect(within(daily).getByText(/^5 saat önce uğradı; günde bir uğrar, sıradaki /)).toBeInTheDocument();
    expect(within(await rowOf('Yeni ajan')).getByText(c.never)).toBeInTheDocument();
    // No raw key, client version, tool count or lateness badge on a closed row.
    for (const article of screen.getAllByRole('article')) {
      expect(article.textContent).not.toMatch(/jt_live|2\.1\.309|0\.63\.0|343|Gecikti|Zamanında/);
    }
    // One row per key, not one per connection that ever came.
    expect(screen.queryByRole('article', { name: 'ops' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('folds the agents not in use away, each with its revoke, and never revokes by itself', async () => {
    const calls = owner();
    renderAt('/agents');
    await rowOf('content-routine');
    const fold = screen.getByText('Kullanılmayanlar (1)').closest('details') as HTMLElement;
    expect(fold).not.toHaveAttribute('open');
    expect(within(fold).getByText(c.unusedHelp)).toBeInTheDocument();
    const row = within(fold).getByRole('article', { name: 'setup' });
    expect(within(row).getByText('8 gündür uğramadı.')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: c.revoke })).toBeInTheDocument();
    expect(calls.some((x) => x.method === 'DELETE')).toBe(false);
  });

  it('says what a person should act on in red: work waits and its agent stays away, or its address is refused', async () => {
    const late = key({ name: 'Dosya ajanı', scopes: ['workspace.read', 'materials.work'] });
    const refusedKey = key({ name: 'Rutin', scopes: ['workspace.read', 'content.work'] });
    const items = [
      { kind: 'studio_material_analysis', material_id: 'm1', expected_revision: 1, priority: 2, hint: '' },
      { kind: 'studio_material_analysis', material_id: 'm2', expected_revision: 1, priority: 2, hint: '' },
      // A person's own task is not the agent's work.
      { kind: 'content_material_request', project_id: 'p1', request_id: 'r1', priority: 2, hint: '' },
    ] as WorkItem[];
    owner({
      'GET /api/api-keys': [late, refusedKey],
      'GET /api/agents': [connection(late, { last_seen_at: at(-3 * HOUR) }), connection(refusedKey, { last_seen_at: at(-20 * MIN) })],
      'GET /api/agents/wakes': wakesOf(
        wake(late, { last_seen_at: at(-3 * HOUR), next_expected_at: at(-2 * HOUR) }),
        wake(refusedKey, { last_seen_at: at(-20 * MIN), address: routine({ refused_at: at(-HOUR) }), last: { at: at(-HOUR), reasons: [], outcome: 'refused', status: 401, session_id: null, session_url: null } }),
      ),
      'GET /api/work/pending': { strategy: 'missing', items, agent: { last_seen_at: null, interval_minutes: 60, overdue: false } },
    });
    renderAt('/agents');
    const row = await rowOf('Dosya ajanı');
    const sentence = await within(row).findByText(`3 saat önce uğradı; ${wakeTimeIn(at(-2 * HOUR), 'tr', 'loc')} bekleniyordu. 2 iş onu bekliyor.`);
    expect(sentence).toHaveClass('text-danger');
    const refused = await rowOf('Rutin');
    expect(within(refused).getByTestId('wake-line')).toHaveTextContent(`Çağrı adresi reddedildi (${wakeTime(at(-HOUR), 'tr')}). Yeni bir belirteçle değiştirin.`);
    expect(within(refused).getByTestId('wake-line')).toHaveClass('text-danger');
    // A refused address has no "Şimdi çalıştır".
    expect(within(refused).queryByRole('button', { name: tr.wake.line.runNow })).not.toBeInTheDocument();
  });

  it('keeps a late agent calm while no work waits for it', async () => {
    const late = key({ name: 'Geç ajan', scopes: ['workspace.read', 'materials.work'] });
    owner({
      'GET /api/api-keys': [late],
      'GET /api/agents': [connection(late, { last_seen_at: at(-3 * HOUR), overdue: true })],
      'GET /api/agents/wakes': wakesOf(wake(late, { last_seen_at: at(-3 * HOUR), next_expected_at: at(-2 * HOUR) })),
    });
    renderAt('/agents');
    const sentence = await within(await rowOf('Geç ajan')).findByText(/bekleniyordu\.$/);
    expect(sentence).not.toHaveClass('text-danger');
  });

  it('counts the agents in chips that filter, hides a chip at zero, and shows none for a single group', async () => {
    const user = userEvent.setup();
    owner();
    renderAt('/agents');
    await rowOf('content-routine');
    const chips = screen.getByRole('group', { name: c.filterLabel });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['Çalışan 3', 'Kullanılmayan 1']);
    await user.click(within(chips).getByRole('button', { name: /Kullanılmayan/ }));
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['setup']);
    expect(screen.queryByText('Kullanılmayanlar (1)')).not.toBeInTheDocument();
    await user.click(within(chips).getByRole('button', { name: /Kullanılmayan/ }));
    expect(screen.getAllByRole('article')).toHaveLength(4);
  });

  it('shows no chips when every agent is in one group', async () => {
    owner({ 'GET /api/api-keys': [content], 'GET /api/agents': contentConns, 'GET /api/agents/wakes': wakesOf(wakes.agents[0]) });
    renderAt('/agents');
    await rowOf('content-routine');
    expect(screen.queryByRole('group', { name: c.filterLabel })).not.toBeInTheDocument();
  });

  it('opens a row in place: the exact permissions folded, the key, the live connection and the earlier ones folded, its latest actions', async () => {
    const user = userEvent.setup();
    const ledger: LedgerEntryOut[] = [
      { id: 9, entry: { workspace_id: WS_ID, at: at(-10 * MIN), actor: { kind: 'agent', connection_id: contentConns[0].id, user_id: me.user_id }, action: 'mcp.tool_call', subject: null, payload: {}, strategy_version_id: null } },
      { id: 8, entry: { workspace_id: WS_ID, at: at(-20 * MIN), actor: { kind: 'agent', connection_id: contentConns[0].id, user_id: me.user_id }, action: 'studio.material.analyzed', subject: null, payload: {}, strategy_version_id: null } },
      { id: 7, entry: { workspace_id: WS_ID, at: at(-30 * MIN), actor: { kind: 'agent', connection_id: researchConn.id, user_id: me.user_id }, action: 'strategy.record', subject: null, payload: {}, strategy_version_id: null } },
    ];
    const calls = owner({ 'GET /api/ledger': ledger });
    renderAt('/agents');
    const row = await openRow('content-routine');
    const detail = within(row);
    const fold = detail.getByText(c.permissionsFold.replace('{n}', '4'));
    expect(fold.closest('details')).not.toHaveAttribute('open');
    await user.click(fold);
    expect(detail.getByText(tr.permissions.content.work)).toBeVisible();
    expect(detail.getByText('jt_live_wYw_…')).toBeInTheDocument();
    expect(detail.getByText('content-routine 1 · son temas 51 dakika önce')).toBeInTheDocument();
    expect(detail.getByText('343 araç çağrısı')).toBeInTheDocument();
    const earlier = detail.getByText('Önceki bağlantılar (2)');
    expect(earlier.closest('details')).not.toHaveAttribute('open');
    await user.click(earlier);
    expect(detail.getByText('ops 1 · son temas evvelsi gün')).toBeInTheDocument();
    // Only the agent as a whole can be late: no badge on any connection.
    expect(row.textContent).not.toMatch(/Gecikti|Zamanında/);
    // Its own worded actions, not the tool calls or another agent's.
    const recent = await detail.findByText(c.recentTitle);
    const list = recent.closest('section') as HTMLElement;
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list.textContent).not.toContain('bir araç kullandı');
    expect(calls.find((x) => x.path === '/api/ledger')?.search).toContain('actor_kind=agent');
    expect(detail.getByRole('button', { name: c.revoke })).toBeInTheDocument();
  });

  it('tells how a key nobody used yet connects, in the opened row', async () => {
    owner();
    renderAt('/agents');
    const row = await openRow('Yeni ajan');
    expect(within(row).getByLabelText(c.mcpUrl)).toHaveValue(`${window.location.origin}/mcp`);
    expect(within(row).getByText(c.keyShownOnce)).toBeInTheDocument();
  });

  it('removes an agent’s access by revoking its key, after asking', async () => {
    const user = userEvent.setup();
    const calls = owner({ [`DELETE /api/api-keys/${setup.id}`]: null });
    renderAt('/agents');
    await rowOf('content-routine');
    const fold = screen.getByText('Kullanılmayanlar (1)').closest('details') as HTMLElement;
    await user.click(within(fold).getByText('Kullanılmayanlar (1)'));
    await user.click(within(within(fold).getByRole('article', { name: 'setup' })).getByRole('button', { name: c.revoke }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/setup anahtarı iptal edilecek/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: c.revoke }));
    await waitFor(() => expect(calls.some((x) => x.method === 'DELETE' && x.path === `/api/api-keys/${setup.id}`)).toBe(true));
    expect(await screen.findByText(c.revoked)).toBeInTheDocument();
  });

  it('keeps revoked keys in their own fold, without actions', async () => {
    const gone = key({ name: 'Eski ajan', status: 'revoked', revoked_at: at(-3 * DAY) });
    owner({ 'GET /api/api-keys': [content, gone], 'GET /api/agents': [...contentConns, connection(gone, { last_seen_at: at(-4 * DAY) })], 'GET /api/agents/wakes': wakesOf(wakes.agents[0]) });
    renderAt('/agents');
    await rowOf('content-routine');
    const fold = screen.getByText('Erişimi kesilenler (1)').closest('details') as HTMLElement;
    const row = within(fold).getByRole('article', { name: 'Eski ajan' });
    expect(within(row).getByText('Erişimi 3 gün önce kesildi.')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: c.revoke })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: tr.wake.line.runNow })).not.toBeInTheDocument();
  });

  it('shows a member without key or team rights the agents, and nothing they cannot do', async () => {
    const calls = owner({ 'GET /api/auth/me': without('api_keys.manage', 'team.manage') });
    renderAt('/agents');
    const row = await rowOf('content-routine');
    expect(within(row).getByText(/^51 dakika önce uğradı/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: c.connect })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: c.revoke })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: c.wakeNone })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: c.wakeChange })).not.toBeInTheDocument();
    // The wake line still says how the agent is called.
    expect(within(row).getByTestId('wake-line')).toHaveTextContent('Claude rutini trig_01ABC');
    expect(calls.some((x) => x.path === '/api/api-keys')).toBe(false);
  });

  it('offers to connect the first agent when there is none', async () => {
    owner({ 'GET /api/agents': [], 'GET /api/api-keys': [], 'GET /api/agents/wakes': wakesOf() });
    renderAt('/agents');
    expect(await screen.findByText(c.empty)).toBeInTheDocument();
    expect(screen.getByText(c.emptyBody)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: c.connect })).toHaveLength(1);
  });

  it('answers the old API keys address and opens the connect dialog when asked to', async () => {
    owner();
    const { router } = renderAt('/api-keys?connect=1');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: c.dialogTitle })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/agents');
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.search).toBe('');
  });
});

describe('Şimdi çalıştır', () => {
  it('wakes the agent at once', async () => {
    const user = userEvent.setup();
    const calls = owner({ [`POST /api/agents/${content.id}/wake/run`]: wakes });
    renderAt('/agents');
    await user.click(within(await rowOf('content-routine')).getByRole('button', { name: tr.wake.line.runNow }));
    await waitFor(() => expect(calls.some((x) => x.method === 'POST' && x.path === `/api/agents/${content.id}/wake/run`)).toBe(true));
  });

  it('waits with the time while the rate limits hold it back, and says a refusal', async () => {
    const after = at(20 * MIN);
    const limited = wakesOf({ ...wakes.agents[0], run_now: { api_key_id: content.id, after } });
    owner({ 'GET /api/agents/wakes': limited });
    renderAt('/agents');
    const row = await rowOf('content-routine');
    expect(within(row).getByRole('button', { name: tr.wake.line.runNow })).toBeDisabled();
    expect(within(row).getByText(`${wakeTimeIn(after, 'tr', 'abl')} sonra çalıştırabilirsiniz.`)).toBeInTheDocument();
  });

  it('says when the server holds the call back', async () => {
    const user = userEvent.setup();
    const retry = at(5 * MIN);
    owner({ [`POST /api/agents/${content.id}/wake/run`]: withStatus(409, { code: 'CONFLICT', message: 'rate limited', details: { reason: 'rate_limited', retry_at: retry } }) });
    renderAt('/agents');
    await user.click(within(await rowOf('content-routine')).getByRole('button', { name: tr.wake.line.runNow }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`Ajan az önce çağrıldı; ${wakeTimeIn(retry, 'tr', 'abl')} sonra yeniden deneyebilirsiniz.`);
  });
});

describe('connecting an agent', () => {
  const answer = (scopes: string[]) => ({ id: 'new-key', name: 'İçerik ajanı', prefix: 'jt_live_new', plaintext: 'jt_live_once_only_secret', scopes, created_at: at(0) });

  it('takes a name and a preset, then shows the key once with where it goes', async () => {
    const user = userEvent.setup();
    const log = vi.spyOn(console, 'log');
    const copyText = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    const calls = owner({ 'POST /api/api-keys': answer(['workspace.read', 'materials.work', 'content.work']) });
    const { client, router } = renderAt('/agents');
    await user.click(await screen.findByRole('button', { name: c.connect }));
    const dialog = await screen.findByRole('dialog');
    // Two choices up front: a name and what it does; the exact permissions behind "Ayrıntı".
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    expect(within(dialog).getByText('Ayrıntı: izinler (0)').closest('details')).not.toHaveAttribute('open');
    await user.type(within(dialog).getByRole('textbox', { name: c.name }), 'İçerik ajanı');
    await user.click(within(dialog).getByRole('button', { name: c.presetContent }));
    expect(within(dialog).getByRole('button', { name: c.presetContent })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText('Ayrıntı: izinler (3)')).toBeInTheDocument();
    // A preset the person's own role cannot give is not offered.
    expect(within(dialog).getByRole('button', { name: c.presetResearch })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: c.submit }));
    expect(calls.find((x) => x.method === 'POST')?.body).toEqual({ name: 'İçerik ajanı', scopes: ['workspace.read', 'materials.work', 'content.work'] });

    expect(await within(dialog).findByDisplayValue('jt_live_once_only_secret')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'İçerik ajanı bağlanmaya hazır' })).toBeInTheDocument();
    expect(within(dialog).getByText(c.readyBody)).toBeInTheDocument();
    expect((within(dialog).getByLabelText(c.command) as HTMLInputElement).value).toContain('Authorization: Bearer jt_live_once_only_secret');
    // Only the explicit button closes it while the key shows.
    await user.keyboard('{Escape}');
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole('button', { name: tr.common.copy })[0]);
    expect(copyText).toHaveBeenCalledWith('jt_live_once_only_secret');
    await user.click(within(dialog).getByRole('button', { name: c.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await act(() => router.navigate('/onboarding'));
    await act(() => router.navigate('/agents'));
    expect(screen.queryByDisplayValue('jt_live_once_only_secret')).not.toBeInTheDocument();
    for (const store of [JSON.stringify(client.getQueryCache().getAll()), JSON.stringify(client.getMutationCache().getAll().map((m) => m.state)), JSON.stringify(log.mock.calls), JSON.stringify(localStorage), JSON.stringify(sessionStorage), router.state.location.search]) {
      expect(store).not.toContain('jt_live_once_only_secret');
    }
  });

  it('gives exactly the permissions chosen under "Ayrıntı"', async () => {
    const user = userEvent.setup();
    const calls = owner({ 'POST /api/api-keys': answer(['ledger.read']) });
    renderAt('/agents');
    await user.click(await screen.findByRole('button', { name: c.connect }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: c.name }), 'Okuyucu');
    await user.click(within(dialog).getByText('Ayrıntı: izinler (0)'));
    await user.click(within(dialog).getByLabelText(tr.permissions.ledger.read, { exact: false }));
    await user.click(within(dialog).getByRole('button', { name: c.submit }));
    await waitFor(() => expect(calls.find((x) => x.method === 'POST')?.body).toEqual({ name: 'Okuyucu', scopes: ['ledger.read'] }));
  });

  it('says at the field what is missing, and sends nothing', async () => {
    const user = userEvent.setup();
    const calls = owner();
    renderAt('/agents');
    await user.click(await screen.findByRole('button', { name: c.connect }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: c.submit }));
    expect(within(dialog).getByText(c.eName)).toBeInTheDocument();
    expect(within(dialog).getByText(c.eScopes)).toBeInTheDocument();
    // "Her şey" turns everything the person holds on, and off again.
    await user.click(within(dialog).getByRole('button', { name: c.presetAll }));
    expect(within(dialog).getByText(`Ayrıntı: izinler (${me.memberships[0].permissions.length})`)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: c.presetAll }));
    expect(within(dialog).getByText('Ayrıntı: izinler (0)')).toBeInTheDocument();
    expect(calls.some((x) => x.method === 'POST')).toBe(false);
  });
});

describe('the agents page’s words', () => {
  it('has the same keys in both languages, none empty', () => {
    expect(Object.keys(AGENT_COPY.en).sort()).toEqual(Object.keys(AGENT_COPY.tr).sort());
    for (const table of [AGENT_COPY.tr, AGENT_COPY.en]) for (const value of Object.values(table)) expect(value.trim()).not.toBe('');
  });

  it('uses every key it defines', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const dir = resolve(__dirname, 'agents');
    const source = [resolve(__dirname, 'AgentsPage.tsx'), ...readdirSync(dir).filter((f) => !f.includes('.test.') && f !== 'copy.ts').map((f) => resolve(dir, f))]
      .map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(Object.keys(AGENT_COPY.tr).filter((k) => !source.includes(`'${k}'`))).toEqual([]);
  });
});
